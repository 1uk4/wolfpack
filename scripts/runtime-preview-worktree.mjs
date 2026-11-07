/**
 * Worktree previews for `wolfpack preview`: run the wolves straight from a built worktree by rewriting the stack's launchd plist
 * (the original bytes are kept in the state file and in a backup, and restored exactly). Node builtins only: copied next to the
 * switch helper under ~/.wolfpack/preview/bin/.
 */
import fs from "node:fs";
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
