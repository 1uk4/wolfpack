#!/usr/bin/env node
/**
 * The stable-release manifest: the latest `<component>/vX.Y.Z` per releasable component (scripts/release-components.json), as
 *   { schema: 1, generatedAt, components: { <component>: { version, tag, sha, publishedAt, notesUrl } } }
 * Built by the manifest job of .github/workflows/release-stable.yml after each stable release and uploaded as `stable.json` to the fixed
 * `stable-manifest` GitHub Release, so it always lives at
 *   https://github.com/<repo>/releases/download/stable-manifest/stable.json
 * Read by @wolfpack/protocol `createManifestFetcher` (console /api/updates). Shape: @wolfpack/protocol StableManifest.
 *
 *   node scripts/stable-manifest.mjs --repo <owner/name> [--check-releases] [--out <file>]
 *     --check-releases  ask GitHub (`gh release view <tag>`, needs GH_TOKEN) whether each candidate tag has a published, non-draft
 *                       release, newest first per component: a tag whose build failed and never published is skipped, so the
 *                       manifest never points at an asset that does not exist. Only the candidates are checked (usually one per
 *                       component), so it never depends on paging through the whole release list.
 *     --out             write the JSON there (default: stdout)
 * Needs the tags in the checkout (fetch-depth: 0 / fetch-tags).
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TAG_RE = /^([a-z0-9]+)\/v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * `tags` = [{ tag, sha (the commit), date (ISO tag date) }]; `isReleased(tag)` (optional) says whether a tag has a published
 * release. Per component the tags are tried highest semver first and the first released one wins, so `isReleased` is called only
 * until a hit. Components with no (released) tag are left out.
 */
export function buildManifest(tags, { repo, components, now = new Date().toISOString(), isReleased } = {}) {
	const byComp = {};
	for (const t of tags) {
		const m = TAG_RE.exec(t.tag);
		if (!m || !components.includes(m[1])) continue;
		(byComp[m[1]] ??= []).push({ v: [+m[2], +m[3], +m[4]], t });
	}
	const out = {};
	for (const c of components) {
		const cands = (byComp[c] ?? []).sort((a, b) => b.v[0] - a.v[0] || b.v[1] - a.v[1] || b.v[2] - a.v[2]);
		const b = cands.find((x) => !isReleased || isReleased(x.t.tag));
		if (!b) continue;
		out[c] = { version: b.v.join("."), tag: b.t.tag, sha: b.t.sha, publishedAt: b.t.date, notesUrl: `https://github.com/${repo}/releases/tag/${b.t.tag}` };
	}
	return { schema: 1, generatedAt: now, components: out };
}

/** Every tag in the checkout with its commit (annotated tags peeled) and tag date. */
export function gitTags(cwd) {
	const raw = execFileSync("git", ["for-each-ref", "refs/tags", "--format=%(refname:short)%09%(*objectname)%09%(objectname)%09%(creatordate:iso-strict)"], { cwd, encoding: "utf8", maxBuffer: 1 << 26 });
	return raw
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			const [tag, peeled, obj, date] = l.split("\t");
			return { tag, sha: peeled || obj, date: new Date(date).toISOString() };
		});
}

/** Runs gh: `(args) => { status, stdout, stderr }` (status null when gh could not be started). */
export function runGh(args) {
	const r = spawnSync("gh", args, { encoding: "utf8" });
	return { status: r.status, stdout: r.stdout ?? "", stderr: r.error ? String(r.error.message) : (r.stderr ?? "") };
}

/** Blocking sleep (the script is synchronous). */
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** gh's answer when the release does not exist: `release not found` (gh's ErrReleaseNotFound) or an HTTP 404 from the API. */
const NOT_FOUND_RE = /release not found|HTTP 404/i;
const RETRY_DELAYS_MS = [2000, 5000];

/**
 * Published, non-draft GitHub Release for `tag`? False only when gh says there is no release (or it is a draft). Any other gh
 * failure (network, 5xx, rate limit, auth) is retried RETRY_DELAYS_MS.length times, then throws with the tag and gh's stderr:
 * a transient error must fail the job, never quietly publish a manifest that points at an older tag.
 */
export function ghReleased(repo, tag, { gh = runGh, sleep = sleepSync } = {}) {
	for (let attempt = 0; ; attempt++) {
		const r = gh(["release", "view", tag, "--repo", repo, "--json", "isDraft", "--jq", ".isDraft"]);
		if (r.status === 0) return r.stdout.trim() === "false";
		if (NOT_FOUND_RE.test(r.stderr)) return false;
		if (attempt >= RETRY_DELAYS_MS.length) throw new Error(`gh release view ${tag} failed after ${attempt + 1} attempts: ${r.stderr.trim() || `exit ${r.status}`}`);
		sleep(RETRY_DELAYS_MS[attempt]);
	}
}

/**
 * Builds the manifest from `tags` (see gitTags) and writes it to `out` (when given); returns the manifest. With `checkReleases`
 * each candidate tag is checked through `gh` (see runGh).
 */
export function writeManifest({ repo, tags, components, checkReleases = false, out, now, gh = runGh, sleep } = {}) {
	const isReleased = checkReleases ? (tag) => ghReleased(repo, tag, { gh, sleep }) : undefined;
	const manifest = buildManifest(tags, { repo, components, now, isReleased });
	if (out) fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
	return manifest;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const arg = (n) => {
		const i = process.argv.indexOf(n);
		return i > 0 ? process.argv[i + 1] : undefined;
	};
	const repo = arg("--repo");
	if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
		console.error("usage: stable-manifest.mjs --repo <owner/name> [--check-releases] [--out <file>]");
		process.exit(2);
	}
	const catalog = JSON.parse(fs.readFileSync(path.join(root, "scripts/release-components.json"), "utf8"));
	const components = Object.keys(catalog).filter((k) => !k.startsWith("_"));
	const out = arg("--out");
	// A gh failure throws here, before anything is written: node exits non-zero, the step fails and the upload step never runs.
	const manifest = writeManifest({ repo, tags: gitTags(root), components, checkReleases: process.argv.includes("--check-releases"), out });
	if (!out) process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}
