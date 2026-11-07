/**
 * Worktree previews for `wolfpack preview`: run the wolves straight from a built worktree by rewriting the stack's launchd plist
 * (the original bytes are kept in the state file and in a backup, and restored exactly). Node builtins only: copied next to the
 * switch helper under ~/.wolfpack/preview/bin/.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

export const workerdEntry = (wt) => path.join(wt, "packages", "workerd", "dist", "bin", "workerd.js");
const xml = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every worktree of the repo that contains `cwd`: [{dir, branch|null, head}]. `git(cwd, ...args)` returns trimmed stdout. */
export function listWorktrees(cwd, git) {
	const out = [];
	let cur;
	for (const line of git(cwd, "worktree", "list", "--porcelain").split("\n")) {
		if (line.startsWith("worktree ")) out.push((cur = { dir: line.slice(9), branch: null, head: "" }));
		else if (cur && line.startsWith("HEAD ")) cur.head = line.slice(5);
		else if (cur && line.startsWith("branch refs/heads/")) cur.branch = line.slice(18);
	}
	return out.map((w) => {
		try {
			return { ...w, dir: fs.realpathSync(w.dir) };
		} catch {
			return w;
		}
	});
}

/** The plist text with the runtime directory (its WorkingDirectory) replaced by `wt` everywhere it appears as a path. */
export function rewriteStackPlist(text, wt) {
	const m = /<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/.exec(text);
	if (!m || !m[1]) throw new Error("the stack plist has no WorkingDirectory");
	return text.replace(new RegExp(`${reEscape(m[1])}(?=[/<"'\\s])`, "g"), () => xml(wt));
}

const backupFile = (dir) => path.join(dir, "stack.plist.orig");

/** Record the original plist bytes (once: a repeat keeps the first record) and return the entry for the state file. */
export function recordPlist({ plist, dir, existing }) {
	if (existing) return existing;
	const bytes = fs.readFileSync(plist);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(backupFile(dir), bytes);
	return { file: plist, backup: backupFile(dir), b64: bytes.toString("base64") };
}

/** Point the plist at `wt`, starting from the recorded original bytes. */
export function pointPlist(rec, wt) {
	fs.writeFileSync(rec.file, rewriteStackPlist(Buffer.from(rec.b64, "base64").toString("utf8"), wt));
}

/** Put the original bytes back exactly. */
export function restorePlist(rec) {
	fs.writeFileSync(rec.file, Buffer.from(rec.b64, "base64"));
	fs.rmSync(rec.backup, { force: true });
}

const stampFile = (home, dir) => path.join(home, ".wolfpack", "preview", "builds", `${crypto.createHash("sha1").update(dir).digest("hex").slice(0, 16)}.json`);

/** Remember a good build, outside the worktree so it never looks dirty. */
export function writeStamp({ home, dir, head }) {
	const file = stampFile(home, dir);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify({ dir, head, builtAt: new Date().toISOString() }, null, 2)}\n`);
}

const GENERATED = ["apps/console/next-env.d.ts"];

/** {status: "built"|"stale"|"not built", dirty}. Stale: HEAD moved, or a changed file is newer than the last build. */
export function buildStatus({ home, dir, git }) {
	let dirty = false;
	let newest = 0;
	for (const l of git(dir, "status", "--porcelain").split("\n")) {
		const f = l.slice(3);
		if (!l || GENERATED.includes(f)) continue;
		if (!l.startsWith("??")) dirty = true;
		try {
			newest = Math.max(newest, fs.statSync(path.join(dir, f)).mtimeMs);
		} catch {}
	}
	let stamp;
	try {
		stamp = JSON.parse(fs.readFileSync(stampFile(home, dir), "utf8"));
	} catch {}
	if (!stamp || !fs.existsSync(workerdEntry(dir))) return { status: "not built", dirty };
	const stale = stamp.head !== git(dir, "rev-parse", "HEAD") || newest > Date.parse(stamp.builtAt);
	return { status: stale ? "stale" : "built", dirty };
}

/** A worker's worktree: `<repo>--<name>-<hex8>`. It is deleted when the worker finishes. */
export const isWorkerCopy = (dir) => /--[A-Za-z0-9_-]+-[0-9a-f]{8}$/.test(path.basename(dir));

/** One picker row per worktree: {dir, name, status, dirty, active, worker}. */
export function pickerRows({ home, cwd, git, activeDir }) {
	return listWorktrees(cwd, git).map((w) => ({
		dir: w.dir,
		name: w.branch ?? w.dir,
		...buildStatus({ home, dir: w.dir, git }),
		active: w.dir === activeDir,
		worker: isWorkerCopy(w.dir),
	}));
}

export const rowLabel = (r) =>
	[`${r.name}  ${r.dir}`, `[${r.status}]`, r.active ? "active" : "", r.dirty ? "uncommitted edits" : "", r.worker ? "worker's copy (vanishes when the worker finishes)" : ""].filter(Boolean).join("  ");

export const WATCH_LABEL = "com.wolfpack.preview-watch";
const watchPlist = (home) => path.join(home, "Library", "LaunchAgents", `${WATCH_LABEL}.plist`);
export const watchFile = (home) => path.join(home, ".wolfpack", "preview", "watch.json");

/** (Re)load the agent that rebuilds the backend packages of `wt` as files save. `script` is the copy under bin/. */
export function startWatch({ home, wt, node, script, uid, launchctl }) {
	if (!fs.existsSync(path.join(wt, "node_modules", "typescript", "bin", "tsc"))) throw new Error(`${wt} has no node_modules/typescript (run \`pnpm install\` there)`);
	let refs;
	try {
		refs = JSON.parse(fs.readFileSync(path.join(wt, "tsconfig.json"), "utf8")).references;
	} catch {}
	if (!Array.isArray(refs) || refs.length === 0) throw new Error(`${wt}/tsconfig.json has no project references to build`);
	const logFile = path.join(home, ".wolfpack", "preview", "watch.log");
	fs.mkdirSync(path.dirname(logFile), { recursive: true });
	fs.rmSync(watchFile(home), { force: true });
	const file = watchPlist(home);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const args = [node, script, wt, watchFile(home), logFile];
	fs.writeFileSync(
		file,
		`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>${WATCH_LABEL}</string>
	<key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
	<key>WorkingDirectory</key><string>${xml(wt)}</string>
	<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(home)}</string><key>PATH</key><string>${xml(process.env.PATH ?? "/usr/bin:/bin")}</string></dict>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ThrottleInterval</key><integer>30</integer>
	<key>StandardOutPath</key><string>${xml(logFile)}</string>
	<key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict>
</plist>
`,
	);
	launchctl("bootout", `gui/${uid}/${WATCH_LABEL}`);
	if (launchctl("bootstrap", `gui/${uid}`, file) !== 0) throw new Error(`launchctl bootstrap of ${file} failed`);
}

export function stopWatch({ home, uid, launchctl }) {
	launchctl("bootout", `gui/${uid}/${WATCH_LABEL}`);
	fs.rmSync(watchPlist(home), { force: true });
	fs.rmSync(watchFile(home), { force: true });
}

/** True when a backend rebuild finished after the stack last started. */
export function restartNeeded({ home, state }) {
	try {
		const rebuilt = Date.parse(JSON.parse(fs.readFileSync(watchFile(home), "utf8")).lastRebuildOk);
		return rebuilt > Date.parse(state.stackStartedAt ?? state.startedAt);
	} catch {
		return false;
	}
}
