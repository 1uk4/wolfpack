#!/usr/bin/env node
// Desktop auto-release helpers (work-wolfpack-GMydeGn), used by .github/workflows/desktop.yml on every merge into stable.
//   node scripts/desktop-release.mjs version [--releases <file>]   -> prints the next desktop version X.Y.Z
//   node scripts/desktop-release.mjs notes <version> <sha>         -> prints the release notes markdown
// Nothing is committed: the workflow stamps the version into apps/desktop/package.json on the runner only.
// Needs full history and all tags (`fetch-depth: 0`). --releases <file> lists release tag names, one per line
// (`gh release list --json tagName,isDraft,targetCommitish`, JSON): a DRAFT release creates no git tag, so it must count too,
// and a draft aimed at the commit being released is reused by a rerun.
// The `notes` command reads only component tags reachable from the given sha.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;
const parse = (v) => { const m = STABLE.exec(v); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; };
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Highest plain X.Y.Z among `<prefix>/vX.Y.Z` names (pre-release tags like -main.N are ignored), or null. */
export function highestVersion(names, prefix) {
	let best = null;
	for (const n of names) {
		if (!n.startsWith(`${prefix}/v`)) continue;
		const v = parse(n.slice(prefix.length + 2));
		if (v && (!best || cmp(v, best) > 0)) best = v;
	}
	return best;
}

/**
 * Next desktop version: +1 patch over the highest desktop/vX.Y.Z (tags and releases), never below package.json's X.Y.Z.
 * Rerun safety: when a desktop tag or a draft release (`headTags`, names) already belongs to the commit being released, that version is reused.
 */
export function nextDesktopVersion({ names, pkgVersion, headTags = [] }) {
	const atHead = highestVersion(headTags, "desktop");
	if (atHead) return atHead.join(".");
	const floor = parse(String(pkgVersion).replace(/-.*$/, ""));
	const top = highestVersion(names, "desktop");
	const next = top ? [top[0], top[1], top[2] + 1] : floor;
	return (floor && cmp(floor, next) > 0 ? floor : next).join(".");
}

/** Release notes: the bundled console and wolfd versions, the hubd and workerd versions of the same release, the commit. */
export function renderNotes({ version, sha, tags }) {
	const v = (c) => { const h = highestVersion(tags, c); return h ? h.join(".") : "unknown"; };
	return [
		`Signed, notarised Mac app ${version}.`,
		"",
		"Bundled parts:",
		`- console ${v("console")}`,
		`- wolfd ${v("wolfd")}`,
		`- hubd ${v("hubd")}`,
		`- workerd ${v("workerd")}`,
		"",
		`Stable commit: ${sha}`,
		"",
	].join("\n");
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 }).trim();
const lines = (s) => s.split("\n").map((l) => l.trim()).filter(Boolean);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [cmd, ...rest] = process.argv.slice(2);
	if (cmd === "version") {
		const i = rest.indexOf("--releases");
		const releases = i >= 0 ? JSON.parse(readFileSync(rest[i + 1], "utf8")) : [];
		const pkg = JSON.parse(readFileSync(path.join(root, "apps/desktop/package.json"), "utf8"));
		const head = git("rev-parse", "HEAD");
		const draftsHere = releases.filter((r) => r.isDraft && r.targetCommitish === head).map((r) => r.tagName);
		console.log(nextDesktopVersion({
			names: [...lines(git("tag", "--list", "desktop/v*")), ...releases.map((r) => r.tagName)],
			pkgVersion: pkg.version,
			headTags: [...lines(git("tag", "--points-at", head)), ...draftsHere].filter((t) => t.startsWith("desktop/")),
		}));
	} else if (cmd === "notes") {
		const [version, sha] = rest;
		if (!version || !sha) { console.error("usage: desktop-release.mjs notes <version> <sha>"); process.exit(2); }
		// Component versions = the highest component tag reachable from the commit (what release-stable tagged).
		process.stdout.write(renderNotes({ version, sha, tags: lines(git("tag", "--merged", sha)) }));
	} else { console.error("usage: desktop-release.mjs version|notes ..."); process.exit(2); }
}
