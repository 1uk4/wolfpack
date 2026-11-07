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

export const cliEntry = (wt) => path.join(wt, "packages", "cli", "dist", "bin", "wolfpack.js");

/** A built cli that understands the bin copy (its preview command exports the PREVIEW_CLI marker); an older one would misread worktree state. */
export function cliCompatible(dir) {
	try {
		return fs.existsSync(cliEntry(dir)) && fs.readFileSync(path.join(dir, "packages", "cli", "dist", "commands", "preview.js"), "utf8").includes("PREVIEW_CLI");
	} catch {
		return false;
	}
}

/** Which checkout the global cli should come from: the worktree if compatible, else the checkout the running script came from, else none. */
export const chooseCli = (wt, fallbackDir) => (cliCompatible(wt) ? { dir: wt, fallback: false } : fallbackDir && cliCompatible(fallbackDir) ? { dir: fallbackDir, fallback: true } : null);

/** The global `wolfpack` is a symlink to the runtime's packages/cli. Record its target (once) before it is repointed; null when it is not a symlink. */
export function recordCli({ link, existing }) {
	if (existing) return existing;
	try {
		if (!link || !fs.lstatSync(link).isSymbolicLink()) return null;
		return { link, target: fs.readlinkSync(link) };
	} catch {
		return null;
	}
}

const setLink = (link, target) => {
	fs.rmSync(link, { force: true });
	fs.symlinkSync(target, link);
};

/** Point the global cli at the worktree's packages/cli, so `wolfpack preview ...` works while the runtime stays on stable. */
export const pointCli = (rec, wt) => setLink(rec.link, path.join(wt, "packages", "cli"));

/** Undo a start that failed: the link goes back to exactly what it was. */
export const resetCli = (rec) => rec && setLink(rec.link, rec.target);

/**
 * Put the original link target back, but only if that checkout's cli has `preview` (stable does not yet, and a global `wolfpack` that
 * answers "Unknown command: preview" is never left behind). Otherwise: the checkout the script ran from, else wherever the link
 * points now (the worktree's cli, if it is compatible), else the original after all. Returns the checkout it stays on, or null
 * when the original was restored.
 */
export function restoreCli(rec, fallbackDir) {
	if (!rec) return null;
	const checkoutOf = (cliDir) => path.dirname(path.dirname(cliDir));
	if (cliCompatible(checkoutOf(rec.target))) return setLink(rec.link, rec.target), null;
	let current;
	try {
		current = checkoutOf(fs.readlinkSync(rec.link));
	} catch {}
	const keep = [fallbackDir, current].find((d) => d && cliCompatible(d));
	if (!keep) return setLink(rec.link, rec.target), null;
	if (keep !== current) setLink(rec.link, path.join(keep, "packages", "cli"));
	return keep;
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

/**
 * {status: "built"|"stale"|"not built", dirty}. A stamp wins: stale when HEAD moved or a changed file is newer than the build.
 * Without a stamp, a worktree counts as built when its workerd and cli dist exist and are newer than its HEAD commit (and than any edit).
 */
export function buildStatus({ home, dir, git }) {
	let dirty = false;
	let newest = 0;
	let newestTracked = 0; // edits to tracked files only: untracked files may be build output
	for (const l of git(dir, "status", "--porcelain").split("\n")) {
		const f = l.slice(3);
		if (!l || GENERATED.includes(f)) continue;
		if (!l.startsWith("??")) dirty = true;
		try {
			const t = fs.statSync(path.join(dir, f)).mtimeMs;
			newest = Math.max(newest, t);
			if (!l.startsWith("??")) newestTracked = Math.max(newestTracked, t);
		} catch {}
	}
	let stamp;
	try {
		stamp = JSON.parse(fs.readFileSync(stampFile(home, dir), "utf8"));
	} catch {}
	if (stamp && fs.existsSync(workerdEntry(dir))) {
		const stale = stamp.head !== git(dir, "rev-parse", "HEAD") || newest > Date.parse(stamp.builtAt);
		return { status: stale ? "stale" : "built", dirty };
	}
	try {
		const dist = Math.min(fs.statSync(workerdEntry(dir)).mtimeMs, fs.statSync(cliEntry(dir)).mtimeMs);
		const committed = Number(git(dir, "log", "-1", "--format=%ct")) * 1000;
		if (dist >= committed) return { status: newestTracked > dist ? "stale" : "built", dirty };
	} catch {} // no dist yet
	return { status: "not built", dirty };
}

/** A worker's worktree: `<repo>--<name>-<hex8>`. It is deleted when the worker finishes. */
export const isWorkerCopy = (dir) => /--[A-Za-z0-9_-]+-[0-9a-f]{8}$/.test(path.basename(dir));
const workerName = (dir) => /--(.+)-[0-9a-f]{8}$/.exec(path.basename(dir))?.[1];

/** Raw facts per worktree, newest information first is not assumed: [{dir, branch, status, dirty, commitTime, merged, main, worker}]. */
export function collectWorktrees({ home, cwd, git, mergedInto = ["wolf/1uk4", "stable"] }) {
	return listWorktrees(cwd, git).map((w, i) => {
		const has = (ref) => {
			try {
				git(w.dir, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
				return true;
			} catch {
				return false;
			}
		};
		const isAncestor = (ref) => {
			try {
				git(w.dir, "merge-base", "--is-ancestor", "HEAD", ref);
				return true;
			} catch {
				return false;
			}
		};
		let commitTime = 0;
		try {
			commitTime = Number(git(w.dir, "log", "-1", "--format=%ct"));
		} catch {}
		return {
			dir: w.dir,
			branch: w.branch,
			...buildStatus({ home, dir: w.dir, git }),
			commitTime,
			merged: mergedInto.some((ref) => has(ref) && isAncestor(ref)),
			main: i === 0,
			worker: isWorkerCopy(w.dir),
		};
	});
}

/**
 * Which worktree does `name` mean? Exact match on the folder name, the branch, or the branch without `feat/` first; else a
 * substring of those. The runtime checkout is never a candidate. → {matches: [{dir, branch}]}
 */
export function matchWorktrees({ worktrees, name, runtimeBranch = "stable", runtimeDir }) {
	const cands = worktrees.filter((w) => w.dir !== runtimeDir && w.branch !== runtimeBranch);
	const keys = (w) => [path.basename(w.dir), w.branch, w.branch?.replace(/^feat\//, "")].filter(Boolean);
	const exact = cands.filter((w) => keys(w).includes(name));
	if (exact.length > 0) return { matches: exact };
	const n = name.toLowerCase();
	return { matches: cands.filter((w) => keys(w).some((k) => k.toLowerCase().includes(n))) };
}

const MARKS = { built: "●", stale: "◐", "not built": "○" };

/** `feat/` dropped; a long slug cut to the id and two words ("yu741qH-floating-chat…"); a worker's copy by its worker name. */
export function shortName(branch, dir) {
	if (isWorkerCopy(dir)) return `${workerName(dir)} (worker)`;
	const b = (branch ?? dir).replace(/^feat\//, "");
	const parts = b.split("-");
	return parts.length > 3 ? `${parts.slice(0, 3).join("-")}…` : b;
}

/**
 * The picker's rows, pure: {rows: [{dir, name, status, active, build, label, hint}], hiddenCount}.
 * Hidden unless `showAll`, active or the cwd's: the runtime branch, the main checkout, detached heads, and merged branches with no edits.
 * Order: active, then the cwd's worktree, then newest commit first.
 */
// The runtime checkout is never offered (not even under Show all, not even as the cwd): previewing it is previewing stable.
export function pickerModel({ worktrees, runtimeBranch = "stable", runtimeDir, here, activeDir, showAll = false, marks = true }) {
	const keep = (w) => w.dir !== runtimeDir && w.branch !== runtimeBranch && (showAll || w.dir === activeDir || w.dir === here || !(w.branch === runtimeBranch || w.main || !w.branch || (w.merged && !w.dirty)));
	const kept = worktrees.filter(keep);
	const rank = (w) => (w.dir === activeDir ? 0 : w.dir === here ? 1 : 2);
	kept.sort((a, b) => rank(a) - rank(b) || b.commitTime - a.commitTime);
	const rows = kept.map((w) => {
		const active = w.dir === activeDir;
		const name = shortName(w.branch, w.dir);
		const build = w.status !== "built";
		if (!marks) {
			// Console picker: branch and worktree folder only; nothing to build, so no built/stale marks.
			return { dir: w.dir, name, status: w.status, active, build: false, label: [`${name}  ${path.basename(w.dir)}`, active ? "active" : ""].filter(Boolean).join("  "), hint: w.dir };
		}
		return {
			dir: w.dir,
			name,
			status: w.status,
			active,
			build,
			label: [`${name}  ${MARKS[w.status]} ${w.status}`, active ? "active" : "", w.dirty ? "edited" : ""].filter(Boolean).join("  "),
			hint: [build ? "builds first, ~3 min" : "", w.worker ? "worker's copy, vanishes when it finishes" : "", w.dir].filter(Boolean).join(" · "), // the path last: the hint is cut to the line
		};
	});
	return { rows, hiddenCount: worktrees.length - kept.length };
}

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
