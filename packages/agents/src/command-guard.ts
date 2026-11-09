/**
 * Read-only command guard for `guarded_bash` (see safe-bash.ts).
 *
 * A denylist, not an allowlist: interpreters (python3, node, perl -e) stay
 * usable. The command is tokenised (quotes, `; && || | &` and newlines), then
 * every simple command is checked, recursing into `$(...)`, backticks,
 * `ssh host '<cmd>'`, `bash -c`, `su -c`, `sudo <cmd>`, `xargs <cmd>`,
 * `find -exec <cmd>` and similar wrappers. Pure functions, no I/O.
 *
 * `wolfpack test` is allowed on purpose: it writes queue and cache files under ~/.wolfpack and ~/.cache, never the
 * checkout, and agents are routed to it (see routeTestCommand below).
 *
 * Known gap: an interpreter can still write or delete (`python3 -c
 * "os.remove(...)"`); that is covered by read-only accounts on the hosts.
 */

import { spawnSync } from "node:child_process";

class GuardBlock extends Error {}
class ParseError extends Error {}

interface Word {
	text: string;
	/** Contains an expansion ($var, $(...), backticks), so its value is unknown. */
	dyn: boolean;
}
interface Redirect {
	op: string;
	target: Word;
}
interface Segment {
	words: Word[];
	redirects: Redirect[];
}
interface Ctx {
	/** Inside an ssh/remote command string: /tmp is not scratch space there. */
	remote: boolean;
	depth: number;
}

const MAX_DEPTH = 8;

// ── Tokeniser ───────────────────────────────────────────────────────────────

/** Index of the `)` matching the `(` at `open`, skipping quotes and escapes. */
function findClose(src: string, open: number): number {
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		const c = src[i];
		if (c === "\\") i++;
		else if (c === "'") {
			const end = src.indexOf("'", i + 1);
			if (end < 0) throw new ParseError("unterminated quote");
			i = end;
		} else if (c === '"') {
			i++;
			while (i < src.length && src[i] !== '"') {
				if (src[i] === "\\") i++;
				i++;
			}
			if (i >= src.length) throw new ParseError("unterminated quote");
		} else if (c === "(") depth++;
		else if (c === ")" && --depth === 0) return i;
	}
	throw new ParseError("unterminated $( ... )");
}

function parse(src: string): { segments: Segment[]; subs: string[] } {
	const segments: Segment[] = [];
	const subs: string[] = [];
	let cur: Segment = { words: [], redirects: [] };
	const flush = () => {
		if (cur.words.length || cur.redirects.length) segments.push(cur);
		cur = { words: [], redirects: [] };
	};
	const n = src.length;

	/** Read one shell word starting at `start`; returns it and the next index. */
	const readWord = (start: number): { word: Word; next: number } => {
		let i = start;
		let text = "";
		let dyn = false;
		const sub = (open: number): number => {
			const close = findClose(src, open);
			subs.push(src.slice(open + 1, close));
			dyn = true;
			text += "$SUBST";
			return close;
		};
		const backtick = (open: number): number => {
			let j = open + 1;
			while (j < n && src[j] !== "`") j += src[j] === "\\" ? 2 : 1;
			if (j >= n) throw new ParseError("unterminated backtick");
			subs.push(src.slice(open + 1, j).replace(/\\`/g, "`"));
			dyn = true;
			text += "$SUBST";
			return j;
		};
		while (i < n && !/[\s;|&<>()]/.test(src[i])) {
			const c = src[i];
			if (c === "\\") {
				if (i + 1 >= n) throw new ParseError("trailing backslash");
				if (src[i + 1] !== "\n") text += src[i + 1];
				i += 2;
			} else if (c === "'") {
				const end = src.indexOf("'", i + 1);
				if (end < 0) throw new ParseError("unterminated quote");
				text += src.slice(i + 1, end);
				i = end + 1;
			} else if (c === '"') {
				i++;
				while (i < n && src[i] !== '"') {
					if (src[i] === "\\" && i + 1 < n) {
						if ("$`\"\\\n".includes(src[i + 1])) {
							if (src[i + 1] !== "\n") text += src[i + 1];
						} else text += src[i] + src[i + 1];
						i += 2;
					} else if (src[i] === "$" && src[i + 1] === "(") i = sub(i + 1) + 1;
					else if (src[i] === "`") i = backtick(i) + 1;
					else {
						if (src[i] === "$") dyn = true;
						text += src[i++];
					}
				}
				if (i >= n) throw new ParseError("unterminated quote");
				i++;
			} else if (c === "$" && src[i + 1] === "(") i = sub(i + 1) + 1;
			else if (c === "`") i = backtick(i) + 1;
			else if (c === "$" && src[i + 1] === "'") {
				const end = src.indexOf("'", i + 2);
				if (end < 0) throw new ParseError("unterminated quote");
				text += src.slice(i + 2, end);
				i = end + 1;
			} else if (c === "$" && src[i + 1] === "{") {
				const end = src.indexOf("}", i);
				if (end < 0) throw new ParseError("unterminated ${");
				text += src.slice(i, end + 1);
				dyn = true;
				i = end + 1;
			} else {
				if (c === "$") dyn = true;
				text += c;
				i++;
			}
		}
		return { word: { text, dyn }, next: i };
	};

	let i = 0;
	while (i < n) {
		const c = src[i];
		if (c === " " || c === "\t" || c === "\r") {
			i++;
			continue;
		}
		if (c === "\\" && src[i + 1] === "\n") {
			i += 2;
			continue;
		}
		if (c === "#") {
			while (i < n && src[i] !== "\n") i++;
			continue;
		}
		if (c === "\n" || c === ";" || c === "|" || c === "(" || c === ")" || (c === "&" && src[i + 1] !== ">")) {
			flush();
			i++;
			continue;
		}
		// Redirects: [fd]>file, >>, >|, >&, &>, &>>, <, <<<, <&, <>, and <( ) / >( ).
		let j = i;
		while (/[0-9]/.test(src[j] ?? "")) j++;
		const fdPrefix = j > i && (src[j] === ">" || src[j] === "<");
		const opStart = fdPrefix ? j : i;
		const oc = src[opStart];
		if (oc === ">" || oc === "<" || (oc === "&" && src[opStart + 1] === ">")) {
			let op = oc;
			let k = opStart + 1;
			if (oc === "&") {
				op = ">";
				k++;
				if (src[k] === ">") k++;
			} else if (src[k] === "(") {
				const close = findClose(src, k);
				subs.push(src.slice(k + 1, close));
				cur.words.push({ text: "/dev/fd/63", dyn: false });
				i = close + 1;
				continue;
			} else if (oc === "<" && src[k] === "<") {
				if (src[k + 1] !== "<") throw new ParseError("here-documents are not supported");
				op = "<<<";
				k += 2;
			} else if (src[k] === ">" || src[k] === "&" || src[k] === "|") {
				op += src[k++];
			} else if (oc === "<" && src[k] === ">") {
				op += src[k++];
			}
			while (src[k] === " " || src[k] === "\t") k++;
			if (k >= n || /[\s;|&<>()]/.test(src[k])) throw new ParseError("redirect without a target");
			const { word, next } = readWord(k);
			i = next;
			const isDup = op.endsWith("&") && /^(\d+|-)$/.test(word.text) && !word.dyn;
			const writes = op.startsWith(">") || op === "<>";
			if (writes && !isDup) cur.redirects.push({ op, target: word });
			continue;
		}
		const { word, next } = readWord(i);
		cur.words.push(word);
		i = next;
	}
	flush();
	return { segments, subs };
}

// ── Rules ───────────────────────────────────────────────────────────────────

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const HARMLESS_WRAPPERS = new Set([
	"if", "then", "else", "elif", "do", "while", "until", "!", "{", "time", "nohup", "exec", "command",
	"builtin", "setsid", "busybox", "env", "nice", "ionice", "timeout", "stdbuf",
]);
const ALWAYS_BLOCKED: Record<string, string> = {
	rm: "deletes files", rmdir: "deletes directories", unlink: "deletes files", shred: "destroys files",
	mv: "moves/overwrites files", dd: "writes raw data", truncate: "truncates files", cp: "writes files",
	touch: "creates or touches files", ln: "creates links", mkfifo: "creates files", install: "writes files", rsync: "writes files", scp: "copies files", wipefs: "destroys filesystems",
	chmod: "changes permissions", chown: "changes ownership", chgrp: "changes ownership",
	setfacl: "changes ACLs", kill: "kills processes", pkill: "kills processes", killall: "kills processes",
	reboot: "reboots the machine", shutdown: "shuts the machine down", halt: "halts the machine",
	poweroff: "powers the machine off", init: "changes runlevel", telinit: "changes runlevel",
	useradd: "changes users", userdel: "changes users", usermod: "changes users", passwd: "changes passwords",
	groupadd: "changes groups", groupdel: "changes groups", groupmod: "changes groups",
	adduser: "changes users", deluser: "changes users", chpasswd: "changes passwords",
	umount: "unmounts filesystems", swapon: "changes swap", swapoff: "changes swap",
	fdisk: "edits partitions", parted: "edits partitions", mkswap: "formats swap",
	source: "runs a file that cannot be checked", ".": "runs a file that cannot be checked",
	vi: "edits files", vim: "edits files", nano: "edits files", ed: "edits files", emacs: "edits files",
};

function clusterHas(arg: string, letters: string, argTaking = ""): boolean {
	if (!/^-[A-Za-z0-9]/.test(arg)) return false;
	for (const ch of arg.slice(1)) {
		if (letters.includes(ch)) return true;
		if (argTaking.includes(ch)) return false;
	}
	return false;
}

/** Drop leading options (and the values of `argOpts`); returns the remaining words. */
function skipOptions(args: Word[], argOpts: string[] = []): Word[] {
	let k = 0;
	while (k < args.length) {
		const t = args[k].text;
		if (t === "--") {
			k++;
			break;
		}
		if (!t.startsWith("-") || t === "-") break;
		k += argOpts.includes(t) ? 2 : 1;
	}
	return args.slice(k);
}

function checkString(src: string, ctx: Ctx): void {
	if (ctx.depth > MAX_DEPTH) throw new ParseError("nesting too deep");
	const { segments, subs } = parse(src);
	for (const s of subs) checkString(s, { ...ctx, depth: ctx.depth + 1 });
	for (const seg of segments) {
		for (const r of seg.redirects) checkRedirect(r, seg, ctx);
		checkWords(seg.words, ctx);
	}
}

function shown(words: Word[]): string {
	const s = words.map((w) => w.text).join(" ");
	return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

function block(what: string, words: Word[], ctx: Ctx): never {
	throw new GuardBlock(
		`Blocked by guarded_bash: ${what}${ctx.remote ? " (in a remote/ssh command)" : ""}. ` +
			`Command: ${shown(words)}. This agent is read-only: do not retry a variant of this command; ` +
			`report what you need to the orchestrator instead.`,
	);
}

function checkRedirect(r: Redirect, seg: Segment, ctx: Ctx): void {
	const t = r.target.text;
	if (!r.target.dyn) {
		if (t === "/dev/null" || t === "/dev/stderr" || t === "/dev/stdout") return;
		if (!ctx.remote && t.startsWith("/tmp/") && !t.split("/").includes("..")) return;
	}
	const hint = ctx.remote ? "remote redirects may only go to /dev/null" : "redirects may only go to /dev/null or /tmp/";
	block(`output redirect \`${r.op} ${t}\` writes a file (${hint})`, seg.words, ctx);
}

function checkWords(all: Word[], ctx: Ctx): void {
	let words = all;
	while (words.length && ASSIGNMENT.test(words[0].text)) words = words.slice(1);
	if (!words.length) return;
	const head = words[0];
	if (head.dyn) block("command name is built from an expansion and cannot be checked", words, ctx);
	const name = head.text.split("/").pop() ?? head.text;
	const args = words.slice(1);
	const argText = args.map((a) => a.text);
	const anyArg = (...vs: string[]) => argText.some((a) => vs.includes(a));
	const deeper: Ctx = { ...ctx, depth: ctx.depth + 1 };
	const deny = (why: string): never => block(`\`${name}\` ${why}`, words, ctx);

	if (ALWAYS_BLOCKED[name]) deny(ALWAYS_BLOCKED[name]);
	if (name.startsWith("mkfs")) deny("creates filesystems");
	if (name === "mount" && args.length) deny("mounts filesystems");

	if (HARMLESS_WRAPPERS.has(name)) {
		let rest: Word[];
		if (name === "env") rest = skipOptions(args, ["-u", "-C", "-S"]);
		else if (name === "nice" || name === "ionice") rest = skipOptions(args, ["-n", "-c", "-p"]);
		else if (name === "timeout") rest = skipOptions(args, ["-s", "-k", "--signal", "--kill-after"]).slice(1);
		else if (name === "stdbuf") rest = skipOptions(args);
		else if (name === "command") rest = skipOptions(args);
		else rest = args;
		checkWords(rest, deeper);
		return;
	}

	switch (name) {
		case "eval":
			checkString(argText.join(" "), deeper);
			return;
		case "sudo":
		case "doas": {
			const rest = skipOptions(args, ["-u", "-g", "-C", "-h", "-p", "-r", "-t", "-U", "-D", "-R", "-T"]);
			if (!rest.length) return deny("without a command opens a privileged shell");
			checkWords(rest, deeper);
			return;
		}
		case "su": {
			const idx = argText.findIndex((a) => a === "-c" || a === "--command" || a.startsWith("--command="));
			if (idx < 0) return deny("without -c opens an interactive shell");
			const a = argText[idx];
			const cmd = a.startsWith("--command=") ? a.slice("--command=".length) : argText[idx + 1];
			if (cmd === undefined) return deny("-c has no command");
			checkString(cmd, deeper);
			return;
		}
		case "ssh": {
			if (argText.some((a) => /proxycommand|localcommand/i.test(a))) deny("-o ProxyCommand/LocalCommand runs local commands");
			let k = 0;
			while (k < args.length) {
				const t = argText[k];
				if (t === "--") {
					k++;
					break;
				}
				if (!t.startsWith("-") || t === "-") break;
				k++;
				for (let c = 1; c < t.length; c++) {
					if ("bcDEeFIiJLlmOopQRSWw".includes(t[c])) {
						if (c === t.length - 1) k++;
						break;
					}
				}
			}
			const rest = args.slice(k + 1);
			if (k >= args.length) deny("needs a host");
			if (!rest.length) deny("without a remote command opens an interactive shell");
			checkString(rest.map((w) => w.text).join(" "), { remote: true, depth: ctx.depth + 1 });
			return;
		}
		case "xargs": {
			const rest = skipOptions(args, ["-I", "-n", "-P", "-d", "-L", "-s", "-E", "-a", "-l"]);
			if (rest.length) checkWords(rest, deeper);
			return;
		}
		case "find": {
			for (let k = 0; k < args.length; k++) {
				const t = argText[k];
				if (t === "-delete") deny("-delete removes files");
				if (/^-(fprint|fprint0|fprintf|fls)$/.test(t)) deny(`${t} writes files`);
				if (/^-(exec|execdir|ok|okdir)$/.test(t)) {
					let e = k + 1;
					while (e < args.length && argText[e] !== ";" && argText[e] !== "+") e++;
					checkWords(args.slice(k + 1, e), deeper);
					k = e;
				}
			}
			return;
		}
		case "sed":
			if (argText.some((a) => a.startsWith("--in-place") || clusterHas(a, "i", "efl"))) deny("-i edits files in place");
			return;
		case "perl":
			if (argText.some((a) => clusterHas(a, "i", "eEMmIdDxXVC"))) deny("-i edits files in place");
			return;
		case "awk":
		case "gawk":
			if (argText.some((a, k) => (a === "-i" && argText[k + 1] === "inplace") || a === "-iinplace")) deny("inplace edits files");
			return;
		case "tee":
			if (argText.some((a) => !a.startsWith("-") && a !== "/dev/null")) deny("writes files (only /dev/null is allowed)");
			return;
		case "ln":
			if (argText.some((a) => a === "--force" || clusterHas(a, "f"))) deny("-f overwrites existing paths");
			return;
		case "bash": case "sh": case "zsh": case "dash": case "ksh": case "ash": {
			let cmd: string | undefined;
			for (let k = 0; k < args.length; k++) {
				const t = argText[k];
				if (t === "-o" || t === "+o" || t === "-O" || t === "+O") k++;
				else if (/^-[A-Za-z]*c[A-Za-z]*$/.test(t)) {
					cmd = argText.slice(k + 1).find((a) => !a.startsWith("-"));
					break;
				} else if (!t.startsWith("-")) break;
			}
			if (cmd === undefined) return deny("without -c would run a script or stdin that cannot be checked; pass the command inline with -c");
			checkString(cmd, deeper);
			return;
		}
		case "systemctl":
		case "service":
		case "rc-service":
			if (anyArg("start", "stop", "restart", "reload", "enable", "disable", "mask", "unmask", "daemon-reload", "daemon-reexec", "kill", "try-restart", "reload-or-restart", "force-reload", "isolate", "set-property", "edit", "revert", "link", "reset-failed", "poweroff", "reboot", "halt", "suspend", "preset"))
				deny("changes service state (only status/show/is-*/list-* are allowed)");
			return;
		case "journalctl":
			if (argText.some((a) => /^--(vacuum|rotate|flush|sync|relinquish|smart-relinquish|setup-keys|update-catalog)/.test(a))) deny("modifies the journal");
			return;
		case "apt": case "apt-get": case "aptitude": case "dpkg": case "yum": case "dnf": case "rpm": case "apk":
			if (anyArg("install", "remove", "purge", "autoremove", "upgrade", "full-upgrade", "dist-upgrade", "reinstall", "erase", "update", "clean", "autoclean", "add", "del", "-i", "-r", "-P", "-e", "-U", "--install", "--remove", "--purge", "--configure", "--erase"))
				deny("changes installed packages");
			return;
		case "npm": case "pnpm": case "yarn": case "pip": case "pip3": case "pipx": case "gem": case "cargo":
			if (anyArg("install", "i", "ci", "add", "uninstall", "remove", "rm", "un", "update", "upgrade", "publish", "link"))
				deny("installs or removes packages");
			return;
		case "crontab":
			if (!anyArg("-l") || anyArg("-r", "-e", "-i")) deny("modifies crontabs (only -l is allowed)");
			return;
		case "iptables": case "ip6tables": case "iptables-restore": case "ip6tables-restore":
			if (name.endsWith("restore") || argText.some((a) => /^-[AIDRFXPNZE]$|^--(append|insert|delete|replace|flush|delete-chain|policy|new-chain|zero|rename-chain)/.test(a)))
				deny("changes firewall rules");
			return;
		case "nft":
			if (anyArg("add", "delete", "flush", "insert", "replace", "create", "destroy", "rename", "reset", "-f", "--file")) deny("changes firewall rules");
			return;
		case "ufw":
			if (!anyArg("status", "show", "version")) deny("changes firewall rules (only status/show is allowed)");
			return;
		case "sysctl":
			if (anyArg("-w", "--write", "-p", "--load", "--system") || argText.some((a) => a.includes("="))) deny("changes kernel parameters");
			return;
		case "docker":
		case "podman":
			if (anyArg("rm", "rmi", "stop", "kill", "restart", "start", "run", "exec", "prune", "cp", "build", "push", "pull", "create", "update", "pause", "unpause", "down", "up", "commit", "load", "import", "rename", "login"))
				deny("changes containers/images (only ps/logs/inspect/stats-style reads are allowed)");
			return;
		case "git": {
			let sub: string | undefined;
			for (let k = 0; k < args.length; k++) {
				const t = argText[k];
				if (["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(t)) k++;
				else if (!t.startsWith("-")) {
					sub = t;
					break;
				}
			}
			const rest = sub === undefined ? [] : argText.slice(argText.indexOf(sub) + 1);
			const bad = ["commit", "push", "reset", "checkout", "clean", "rebase", "merge", "cherry-pick", "revert", "pull", "restore", "switch", "rm", "mv", "apply", "am", "gc", "prune", "init", "fetch", "add", "bisect", "filter-branch"];
			if (sub && bad.includes(sub)) deny(`git ${sub} changes the repository (only log/show/diff/status-style reads are allowed)`);
			// Researchers read repos via a shallow clone into scratch space: allow it
			// locally, into an explicit /tmp/ destination only.
			if (sub === "clone") {
				if (ctx.remote) deny("git clone writes files on the host");
				const withValue = ["--depth", "--branch", "-b", "--origin", "-o", "--config", "-c", "--reference", "--separate-git-dir", "--shallow-since", "--shallow-exclude", "--filter", "-j", "--jobs", "--template", "-u", "--upload-pack"];
				const positional: string[] = [];
				for (let k = 0; k < rest.length; k++) {
					if (withValue.includes(rest[k])) k++;
					else if (!rest[k].startsWith("-")) positional.push(rest[k]);
				}
				const dest = positional[1];
				if (!dest || !dest.startsWith("/tmp/") || dest.split("/").includes("..")) deny("git clone is only allowed into an explicit /tmp/ destination");
			}
			if (sub === "stash" && !["list", "show"].includes(rest[0] ?? "")) deny("git stash changes the repository");
			if (sub === "branch" && rest.some((a) => /^(-d|-D|-m|-M|-c|-C|-f|-u|--delete|--move|--copy|--force|--set-upstream-to|--unset-upstream|--edit-description)/.test(a))) deny("git branch changes branches");
			if (sub === "tag" && rest.some((a) => /^(-d|-f|-a|-s|-m|--delete|--force|--annotate|--sign)/.test(a))) deny("git tag changes tags");
			if (sub === "config" && !rest.some((a) => /^(--get|--list|-l|--get-all|--get-regexp)/.test(a))) deny("git config writes config");
			if (sub === "remote" && rest[0] && !["-v", "show", "get-url"].includes(rest[0])) deny("git remote changes remotes");
			if (rest.some((a) => a.startsWith("--output"))) deny("--output writes a file");
			return;
		}
		case "curl": {
			const bad = (why: string): never => deny(why);
			const method = (m: string | undefined) => {
				if (m !== undefined && !/^(GET|HEAD)$/i.test(m)) bad(`-X ${m} is not a read (only GET/HEAD)`);
			};
			for (let k = 0; k < args.length; k++) {
				const t = argText[k];
				if (t.startsWith("--")) {
					const eq = t.indexOf("=");
					const opt = eq < 0 ? t : t.slice(0, eq);
					const val = eq < 0 ? argText[k + 1] : t.slice(eq + 1);
					if (opt === "--request") method(val);
					else if (opt === "--output" || opt === "--dump-header") {
						if (val !== "/dev/null" && !(opt === "--dump-header" && val === "-")) bad(`${opt} writes a file`);
					} else if (/^--(remote-name|upload-file|data|form|json|cookie-jar|create-dirs|trace|libcurl|output-dir)/.test(opt)) bad(`${opt} writes files or sends a body`);
				} else if (t.startsWith("-") && t.length > 1) {
					for (let c = 1; c < t.length; c++) {
						const ch = t[c];
						const rest = t.slice(c + 1) || argText[k + 1];
						if (ch === "O" || ch === "T" || ch === "d" || ch === "F" || ch === "c") bad(`-${ch} writes files or sends a body`);
						if (ch === "o" || ch === "D") {
							if (rest !== "/dev/null" && !(ch === "D" && rest === "-")) bad(`-${ch} writes a file`);
						}
						if (ch === "X") method(rest);
						if ("AbCeEHKmPQrtuUwxXyYzoD".includes(ch)) {
							if (c === t.length - 1) k++;
							break;
						}
					}
				}
			}
			return;
		}
		case "wget": {
			let toStdout = false;
			for (let k = 0; k < args.length; k++) {
				const t = argText[k];
				if (t === "--spider") toStdout = true;
				else if (t.startsWith("--output-document") || t.startsWith("--post") || t.startsWith("--body") || t.startsWith("--method") || t.startsWith("--output-file") || t.startsWith("--directory-prefix")) {
					const val = t.includes("=") ? t.slice(t.indexOf("=") + 1) : argText[k + 1];
					if (t.startsWith("--output-document") && val === "-") toStdout = true;
					else if (t.startsWith("--method") && /^(GET|HEAD)$/i.test(val ?? "")) continue;
					else deny(`${t.split("=")[0]} writes files or sends a body`);
				} else if (/^-[A-Za-z]/.test(t) && !t.startsWith("--")) {
					for (let c = 1; c < t.length; c++) {
						const ch = t[c];
						const rest = t.slice(c + 1) || argText[k + 1];
						if (ch === "O") {
							if (rest === "-") toStdout = true;
							else deny("-O writes a file (use -O -)");
						}
						if (ch === "o" || ch === "a" || ch === "P" || ch === "i") deny(`-${ch} writes or reads files`);
						if ("OoaPiTtwUeBQ".includes(ch)) {
							if (c === t.length - 1) k++;
							break;
						}
					}
				}
			}
			if (!toStdout) deny("saves to a file by default (use -O - or --spider)");
			return;
		}
		default:
			if ((name === "python" || name.startsWith("python3")) && argText.includes("-m") && /^pip/.test(argText[argText.indexOf("-m") + 1] ?? ""))
				checkWords([{ text: "pip", dyn: false }, ...args.slice(argText.indexOf("-m") + 2)], deeper);
	}
}

/**
 * Returns a human-readable block reason for a read-only agent, or null if the
 * command may run.
 */
export function checkReadOnlyCommand(command: string): string | null {
	try {
		checkString(command, { remote: false, depth: 0 });
		return null;
	} catch (e) {
		if (e instanceof GuardBlock) return e.message;
		if (e instanceof ParseError) return `Blocked by guarded_bash: couldn't parse; simplify the command (${e.message}).`;
		throw e;
	}
}

// ── Worker shells: git and GitHub lockdown ──────────────────────────────────

/** git subcommands a worker may run; everything else (push, merge, reset, checkout, tag, stash, ...) is refused. */
const WORKER_GIT_ALLOWED = new Set([
	"add", "commit", "status", "diff", "log", "show", "rev-parse", "merge-base", "ls-files", "blame", "grep",
	"rebase", // only its own branch onto one ref, the fixup-squash forms, --continue/--abort/--skip; see workerGit
	"rev-list", "cat-file", "ls-tree", "describe", "diff-tree", "shortlog", "for-each-ref", "name-rev", "show-ref", "branch",
	"restore", "rm", "mv", "checkout", "config", "remote", // restricted forms, see workerGit
]);
/** Global git flags without a value. Anything that takes one (-C, --git-dir, --work-tree, --namespace, -c) is refused: a worker stays in its own worktree. */
const WORKER_GIT_GLOBAL_FLAG = new Set(["--version", "--no-pager", "-p", "-P", "--paginate", "--no-replace-objects", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--no-optional-locks"]);
/** Environment variables that make git run a program or load config of the caller's choosing. */
const WORKER_GIT_ENV = /^(GIT_(CONFIG\w*|EXEC_PATH|SSH\w*|ASKPASS|EDITOR|SEQUENCE_EDITOR|PAGER|EXTERNAL_DIFF|PROXY_COMMAND|TERMINAL_PROMPT|DIR|WORK_TREE)|SSH_ASKPASS|GH_\w+|GITHUB_\w+)=(.*)$/s;

function workerBlock(what: string, words: Word[]): never {
	throw new GuardBlock(
		`Blocked by bash: ${what}. Command: ${shown(words)}. Workers may only run add, commit (not --amend), status, diff, log, show, rev-parse, merge-base, ` +
			`ls-files, blame, grep and the fixup rebase (rebase -i --autosquash <base>); push, merge, reset, checkout and gh belong to the orchestrator. ` +
			`Do not retry a variant; report what you need.`,
		);
}

function workerGit(words: Word[], args: Word[]): void {
	const t = args.map((a) => a.text);
	let k = 0;
	for (; k < t.length; k++) {
		const a = t[k];
		if (WORKER_GIT_GLOBAL_FLAG.has(a)) continue;
		else if (a.startsWith("-")) workerBlock(`git option \`${a}\` is not allowed (no -C, --git-dir, --work-tree or -c: stay in your worktree)`, words);
		else break;
	}
	const sub = t[k];
	if (args[k]?.dyn) workerBlock("git subcommand is built from an expansion and cannot be checked", words);
	if (sub === undefined) return;
	if (!WORKER_GIT_ALLOWED.has(sub)) workerBlock(`\`git ${sub}\` is not allowed`, words);
	const rest = t.slice(k + 1);
	if (sub === "commit" && rest.some((a) => (a === "--amend") || (/^--am/.test(a) && "--amend".startsWith(a)))) workerBlock("git commit --amend is not allowed (use --fixup)", words);
	if (sub === "grep" && rest.some((a) => /^-[A-Za-z0-9]*O/.test(a) || a.startsWith("--open-files-in-pager"))) workerBlock("git grep -O runs a program", words);
	if (["log", "diff", "show"].includes(sub) && rest.some((a) => /^--ou/.test(a) && "--output".startsWith(a.split("=")[0]!))) workerBlock("--output writes a file", words);
	if (sub === "checkout" && !(rest[0] === "--" && rest.length > 1)) workerBlock("git checkout is only allowed as `checkout -- <paths>`", words);
	if (sub === "restore" && rest.some((a) => a === "-s" || a.startsWith("--source"))) workerBlock("git restore --source is not allowed", words);
	if (sub === "config" && !(rest.length === 2 && rest[0] === "--get")) workerBlock("git config may only read: `config --get <key>`", words);
	if (sub === "remote" && !(rest.length === 0 || (rest.length === 1 && (rest[0] === "-v" || rest[0] === "--verbose")))) workerBlock("git remote may only list: `remote -v`", words);
	if (sub === "branch") {
		const listing = rest.some((a) => /^(--list|-l|--contains|--no-contains|--merged|--no-merged|--show-current)$/.test(a));
		if (rest.some((a) => /^(-[dDmMcCfut]|--delete|--move|--copy|--force|--set-upstream|--unset-upstream|--edit-description|--track|--no-track)/.test(a)) || (!listing && rest.some((a) => !a.startsWith("-"))))
			workerBlock("git branch may only list branches", words);
	}
	if (sub === "rebase") {
		if (rest.length === 1 && ["--abort", "--continue", "--skip"].includes(rest[0]!)) return;
		const flags = rest.filter((a) => a.startsWith("-"));
		const pos = rest.filter((a) => !a.startsWith("-"));
		const plain = flags.length === 0 && pos.length === 1; // (a worker rebases its own branch onto one ref: the conflict-resolve brief)
		if (!plain && (!flags.includes("--autosquash") || !flags.every((a) => a === "-i" || a === "--interactive" || a === "--autosquash") || pos.length > 1))
			workerBlock("git rebase is only allowed as `rebase <ref>`, `rebase -i --autosquash <base>`, `rebase --autosquash`, `--abort`, `--continue` or `--skip`", words);
	}
}

function workerWords(all: Word[], depth: number): void {
	if (depth > MAX_DEPTH) throw new ParseError("nesting too deep");
	let words = all;
	while (words.length && ASSIGNMENT.test(words[0].text)) {
		const m = WORKER_GIT_ENV.exec(words[0].text);
		if (m && !(/^GIT_(SEQUENCE_)?EDITOR$/.test(m[1] ?? "") && [":", "true", ""].includes(m[3] ?? "x"))) workerBlock(`setting ${words[0].text.split("=")[0]} is not allowed`, words);
		words = words.slice(1);
	}
	if (!words.length) return;
	const head = words[0];
	if (head.dyn) workerBlock("command name is built from an expansion and cannot be checked", words);
	const name = head.text.split("/").pop() ?? head.text;
	const args = words.slice(1);
	const t = args.map((a) => a.text);
	if (name === "gh") workerBlock("`gh` is not available to workers", words);
	if (name === "git") return workerGit(words, args);
	if (HARMLESS_WRAPPERS.has(name)) {
		let rest: Word[];
		if (name === "env") {
			for (let k = 0; k < t.length && t[k]!.startsWith("-"); k++) {
				if (/^-[A-Za-z]*S|^--split-string/.test(t[k]!)) workerBlock("env -S builds a command from a string and cannot be checked", words);
				if (t[k] === "-u" || t[k] === "-C") k++;
			}
			rest = skipOptions(args, ["-u", "-C"]);
		}
		else if (name === "nice" || name === "ionice") rest = skipOptions(args, ["-n", "-c", "-p"]);
		else if (name === "timeout") rest = skipOptions(args, ["-s", "-k", "--signal", "--kill-after"]).slice(1);
		else if (name === "stdbuf" || name === "command") rest = skipOptions(args);
		else rest = args;
		return workerWords(rest, depth + 1);
	}
	switch (name) {
		case "export": case "declare": case "typeset": case "local": case "readonly":
			return workerWords(args.filter((a) => ASSIGNMENT.test(a.text)), depth + 1);
		case "eval":
			return workerString(t.join(" "), depth + 1);
		case "sudo": case "doas":
			return workerWords(skipOptions(args, ["-u", "-g", "-C", "-h", "-p", "-r", "-t", "-U", "-D", "-R", "-T"]), depth + 1);
		case "su": {
			const idx = t.findIndex((a) => a === "-c" || a === "--command" || a.startsWith("--command="));
			if (idx >= 0) workerString(t[idx]!.startsWith("--command=") ? t[idx]!.slice(10) : (t[idx + 1] ?? ""), depth + 1);
			return;
		}
		case "source": case ".":
			return workerBlock("`source` runs a file that cannot be checked", words);
		case "npx": case "pnpx": case "bunx":
			return workerWords(skipOptions(args), depth + 1);
		case "pnpm": case "npm": case "yarn": case "bun": {
			const at = t.findIndex((a) => a === "exec" || a === "dlx");
			if (at >= 0) workerWords(skipOptions(args.slice(at + 1)), depth + 1);
			return;
		}
		case "bash": case "sh": case "zsh": case "dash": case "ksh": case "ash": {
			// Reading the program from stdin (a pipe, <<<, a here-doc, <file) or from a file that is not a plain repo-relative path
			// (process substitution, absolute, .., an expansion) cannot be checked: refused. `sh scripts/x.sh` stays allowed so repo scripts run;
			// what a script itself does is a known gap, like python3 -c.
			for (let k = 0; k < args.length; k++) {
				const a = t[k]!;
				if (a === "-o" || a === "+o" || a === "-O" || a === "+O") k++;
				else if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) return workerString(t.slice(k + 1).find((x) => !x.startsWith("-")) ?? "", depth + 1);
				else if (!a.startsWith("-")) {
					if (args[k]!.dyn || a.startsWith("/") || a.startsWith("<") || a.startsWith("~") || a.split("/").includes("..")) workerBlock("a shell script given by an absolute, parent-relative or computed path cannot be checked", words);
					return;
				}
			}
			return workerBlock("a shell reading its program from stdin cannot be checked (use `sh -c '…'` or a repo script)", words);
		}
		case "ssh": {
			let k = 0;
			while (k < args.length) {
				const a = t[k]!;
				if (a === "--") { k++; break; }
				if (!a.startsWith("-") || a === "-") break;
				k++;
				for (let c = 1; c < a.length; c++) if ("bcDEeFIiJLlmOopQRSWw".includes(a[c]!)) { if (c === a.length - 1) k++; break; }
			}
			const rest = args.slice(k + 1);
			if (rest.length) workerString(rest.map((w) => w.text).join(" "), depth + 1);
			return;
		}
		case "xargs": {
			const rest = skipOptions(args, ["-I", "-n", "-P", "-d", "-L", "-s", "-E", "-a", "-l"]);
			if (rest.length) workerWords(rest, depth + 1);
			return;
		}
		case "find":
			for (let k = 0; k < args.length; k++) {
				if (/^-(exec|execdir|ok|okdir)$/.test(t[k]!)) {
					let e = k + 1;
					while (e < args.length && t[e] !== ";" && t[e] !== "+") e++;
					workerWords(args.slice(k + 1, e), depth + 1);
					k = e;
				}
			}
			return;
	}
}

function workerString(src: string, depth: number): void {
	if (depth > MAX_DEPTH) throw new ParseError("nesting too deep");
	const { segments, subs } = parse(src);
	for (const s of subs) workerString(s, depth + 1);
	for (const seg of segments) workerWords(seg.words, depth);
}

/**
 * The git and GitHub lockdown for a worker or other writing subagent's `bash`: a block reason, or null. Unlike
 * checkReadOnlyCommand it leaves everything but git and gh alone. This steers a cooperative worker; it is NOT a hard barrier:
 * an interpreter (`python3 -c`, `node -e`, a script the worker wrote) can still run git. The environment hardening in
 * the harness (no GitHub tokens, no ssh agent, a failing GIT_SSH_COMMAND) is the second layer, not a guarantee.
 */
export function checkWorkerCommand(command: string): string | null {
	try {
		workerString(command, 0);
		return null;
	} catch (e) {
		if (e instanceof GuardBlock) return e.message;
		if (e instanceof ParseError) return `Blocked by bash: couldn't parse; simplify the command (${e.message}).`;
		throw e;
	}
}

// ── Routing test runs through `wolfpack test` ───────────────────────────────

/**
 * Packages whose `test` script is `vitest run … packages/<name>/src`: `pnpm --filter @wolfpack/<name> test` becomes
 * `wolfpack test run packages/<name>`. The console (a `tsx --test` suite) and anything unlisted are left alone.
 */
const VITEST_PACKAGES = new Set([
	"memory", "workerd", "kb", "hubd", "agents", "agent", "protocol", "cli", "workspaces", "harness", "work-server", "engine", "client",
]);

const ROUTE_NOTE = "echo '[wolfpack] test run routed through the test queue (wolfpack test)' >&2; ";

/** Split at top-level `&&`, `||`, `;`, `|`, `&` and newlines; undefined when the text has structure it does not take apart. */
function splitSegments(src: string): Array<{ text: string; sep: string }> | undefined {
	const out: Array<{ text: string; sep: string }> = [];
	let cur = "";
	const push = (sep: string) => {
		out.push({ text: cur, sep });
		cur = "";
	};
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		if (c === "\\") return undefined;
		if (c === "'") {
			const end = src.indexOf("'", i + 1);
			if (end < 0) return undefined;
			cur += src.slice(i, end + 1);
			i = end;
		} else if (c === '"') {
			let j = i + 1;
			while (j < src.length && src[j] !== '"') {
				if (src[j] === "\\" || src[j] === "`" || (src[j] === "$" && src[j + 1] === "(")) return undefined;
				j++;
			}
			if (j >= src.length) return undefined;
			cur += src.slice(i, j + 1);
			i = j;
		} else if (c === "`" || c === "(" || c === ")" || (c === "$" && src[i + 1] === "(")) return undefined;
		else if (c === "<" && src[i + 1] === "<") return undefined;
		else if (c === "#" && (cur === "" || /\s$/.test(cur))) return undefined;
		else if ((c === "&" && src[i + 1] === "&") || (c === "|" && src[i + 1] === "|")) {
			push(c + c);
			i++;
		} else if (c === "&" && (cur.endsWith(">") || cur.endsWith("<") || src[i + 1] === ">")) cur += c;
		else if (c === ";" || c === "|" || c === "&" || c === "\n") push(c);
		else cur += c;
	}
	out.push({ text: cur, sep: "" });
	return out;
}

/** Shell words of one segment, raw (quotes kept); undefined on an unbalanced quote. */
function rawWords(s: string): string[] | undefined {
	const words: string[] = [];
	let cur = "";
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === " " || c === "\t") {
			if (cur) words.push(cur);
			cur = "";
		} else if (c === "'" || c === '"') {
			const end = s.indexOf(c, i + 1);
			if (end < 0) return undefined;
			cur += s.slice(i, end + 1);
			i = end;
		} else cur += c;
	}
	if (cur) words.push(cur);
	return words;
}

const REDIRECT_WORD = /^(\d*>>?|&>|\d*<)$/;
const REDIRECT_ATTACHED = /^(\d*>>?|&>|\d*<)\S/;

/** `wolfpack test` arguments for the words after a vitest/test-script command; undefined when they cannot be routed. */
function routeArgs(words: string[]): string[] | undefined {
	const out: string[] = [];
	let first = true;
	for (let i = 0; i < words.length; i++) {
		const w = words[i]!;
		if (w === "--run") continue;
		if (w === "--" && first) continue; // `pnpm test -- run x`: the separator before the script's arguments
		if (/[$*?[]/.test(w.replace(/'[^']*'|"[^"]*"/g, ""))) return undefined;
		if (REDIRECT_WORD.test(w)) {
			if (words[i + 1] === undefined) return undefined;
			out.push(w, words[++i]!);
		} else if (REDIRECT_ATTACHED.test(w)) out.push(w);
		else if (w === "-t" || w === "--testNamePattern") {
			if (words[i + 1] === undefined) return undefined;
			out.push(w, words[++i]!);
		} else if (w === "--no-cache") out.push(w);
		else if (w.startsWith("-")) return undefined;
		else {
			if (first && /^(watch|dev|bench|init|list|typecheck|--)$/.test(w)) return undefined;
			out.push(w);
		}
		first = false;
	}
	return out;
}

function routeSegment(text: string): { text: string; namesPath: boolean } | undefined {
	const m = /^(\s*)((?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*)(.*)$/.exec(text);
	if (!m) return undefined;
	const [, lead, envs, rest] = m as unknown as [string, string, string, string];
	if (/\bWOLFPACK_TEST_BYPASS=/.test(envs)) return undefined;
	const words = rawWords(rest);
	if (!words?.length) return undefined;
	let used = 0;
	let pkgDir: string | undefined;
	const w = words;
	if (w[0] === "npx" && w[1] === "vitest") used = 2;
	else if (w[0] === "pnpm" && w[1] === "exec" && w[2] === "vitest") used = 3;
	else if (w[0] === "pnpm" && w[1] === "vitest") used = 2;
	else if (/(^|\/)vitest$/.test(w[0]!) && w[0] !== "npx") used = 1;
	// (bare `pnpm test` / `npm test` / `npm run test` are not routed: they run the suite of the directory they are run in,
	// and `wolfpack test` without paths would run the whole repo's)
	else if (w[0] === "pnpm" && (w[1] === "--filter" || w[1] === "-F") && w[3] === "test") {
		const m2 = /^@wolfpack\/(.+)$/.exec(w[2]!);
		if (!m2 || !VITEST_PACKAGES.has(m2[1]!)) return undefined;
		pkgDir = `packages/${m2[1]}`;
		used = 4;
	} else return undefined;
	const args = routeArgs(w.slice(used));
	if (!args) return undefined;
	const tail = pkgDir ? ["run", pkgDir, ...args] : args;
	// "names a path": a --filter package, or a word that looks like one (contains `/` or ends in a file extension)
	const namesPath = Boolean(pkgDir) || args.some((a, i) => !a.startsWith("-") && args[i - 1] !== "-t" && args[i - 1] !== "--testNamePattern" && /\/|\.[A-Za-z0-9]+['"]?$/.test(a));
	return { text: `${lead}${envs}${["wolfpack", "test", ...tail].join(" ")}${/\s*$/.exec(text)![0]}`, namesPath };
}

/** A segment that changes the directory the following segments run in. */
const CHANGES_DIR = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:cd|pushd)(?:\s|$)/;

type SpawnResult = { status: number | null; error?: (Error & { code?: string }) | undefined };

/**
 * A support check that keeps only a definite answer: exit 0 is yes; a non-zero exit or ENOENT (no `wolfpack` on PATH) is
 * no. A timeout or any other spawn error says nothing about the install, so it counts as "not supported" for that call
 * only and is asked again next time. `spawn` is injectable for tests.
 */
export function makeSupportCheck(
	spawn: (cmd: string, args: string[], opts: { stdio: "ignore"; timeout: number }) => SpawnResult = spawnSync,
): () => boolean {
	let known: boolean | undefined;
	return () => {
		if (known !== undefined) return known;
		const r = spawn("wolfpack", ["test", "--help"], { stdio: "ignore", timeout: 15_000 });
		if (r.error) {
			if (r.error.code === "ENOENT") return (known = false);
			return false;
		}
		if (r.status === null) return false; // killed by a signal or the timeout: unknown
		return (known = r.status === 0);
	};
}

/** Whether the `wolfpack` on PATH can run `test` (an older install cannot): `wolfpack test --help` exits 0. */
export const wolfpackSupportsTest: () => boolean = makeSupportCheck();

/**
 * Agent shells (WOLFPACK_AGENT_RUN=1) must not start vitest themselves: a direct test run (`vitest`, `npx vitest`,
 * `pnpm exec vitest`, `pnpm vitest`, `pnpm --filter X test`) is rewritten to
 * `wolfpack test …` with the same arguments, so it queues, is capped and is cached. Rewrites only, never blocks, and only
 * the test segment of a compound command; anything the scanner is unsure about (substitutions, subshells, heredocs,
 * comments, unknown flags, vitest subcommands) is returned unchanged. `WOLFPACK_TEST_BYPASS` (env or inline) is honoured.
 */
export function routeTestCommand(
	command: string,
	env: NodeJS.ProcessEnv = process.env,
	supported: () => boolean = wolfpackSupportsTest,
): { command: string; routed: boolean } {
	const same = { command, routed: false };
	if (env.WOLFPACK_AGENT_RUN !== "1" || env.WOLFPACK_TEST_BYPASS) return same;
	const segments = splitSegments(command);
	if (!segments) return same;
	const routes = segments.map((s) => routeSegment(s.text));
	if (routes.every((r) => r === undefined)) return same;
	// After a cd/pushd, a test segment that names no path would run the whole repo instead of the directory's own suite.
	let cd = false;
	for (let i = 0; i < segments.length; i++) {
		if (routes[i] && cd && !routes[i]!.namesPath) return same;
		if (CHANGES_DIR.test(segments[i]!.text)) cd = true;
	}
	// Ask only when there is something to route, and leave the command alone when `wolfpack test` would not run.
	if (!supported()) return same;
	const rebuilt = segments.map((s, i) => (routes[i]?.text ?? s.text) + s.sep);
	return { command: ROUTE_NOTE + rebuilt.join(""), routed: true };
}
