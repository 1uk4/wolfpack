#!/usr/bin/env node
// Auto-tag for pushes to stable (.github/workflows/release-stable.yml): tag every component changed since its last
// <component>/vX.Y.Z tag at +1 patch, push each tag on its own, print the new tags as JSON to $GITHUB_OUTPUT (`tags=[...]`).
// Same planner as `wolfpack release` (packages/cli/src/release.ts, loaded via Node's type stripping, no CLI build needed).
// --channel main --ref <ref>: tag the commit <ref> names (default HEAD) as <component>/vX.Y.Z-main.N instead (release-main.yml).
// Usage: node scripts/auto-tag.mjs [--dry-run] [--channel stable|main] [--ref <ref>]   (needs full history + tags; run from the repo)
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 }).trim();
const lines = (s) => s.split("\n").filter(Boolean);
const dryRun = process.argv.includes("--dry-run");
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const channel = arg("--channel") ?? "stable";
if (channel !== "stable" && channel !== "main") { console.error(`--channel must be stable or main, got ${channel}`); process.exit(2); }

const { planRelease, pushTagsSeparately } = await import(pathToFileURL(path.join(root, "packages/cli/src/release.ts")).href);
const aff = await import(pathToFileURL(path.join(root, "scripts/affected.mjs")).href);
const catalog = JSON.parse(readFileSync(path.join(root, "scripts/release-components.json"), "utf8"));
const components = Object.keys(catalog).filter((k) => !k.startsWith("_"));
const workspaces = aff.loadWorkspaces(root);
const head = git("rev-parse", `${arg("--ref") ?? "HEAD"}^{commit}`);

const items = planRelease(
  { components, bump: "patch", channel },
  {
    tags: () => lines(git("tag", "--list")),
    headTags: () => lines(git("tag", "--points-at", head)),
    changedFiles: (base) => aff.changedFiles(base, head, root),
    affected: (files) => aff.computeAffected(files, workspaces).components,
    commits: (base) => lines(git("log", "--no-merges", "--format=%h %s", base ? `${base}..${head}` : head)),
  },
);
const tags = items.map((i) => i.tag);
console.log(tags.length ? `tagging ${head.slice(0, 7)}: ${tags.join(", ")}` : "no component changed: nothing to tag");
if (!dryRun) {
  for (const i of items) git("tag", "-a", i.tag, "-m", `${i.component} ${i.version}`, head);
  pushTagsSeparately((...a) => git(...a), "origin", tags);
}
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tags=${JSON.stringify(tags)}\n`);
