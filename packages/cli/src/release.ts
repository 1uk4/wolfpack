/**
 * Release planning for `wolfpack release`: per component, find its last `<component>/vX.Y.Z` tag, ask
 * scripts/affected.mjs (computeAffected) whether it changed since then, and suggest the next version.
 * Pure helpers here (unit-tested); git/affected access is injected via ReleaseDeps.
 */

export interface ReleaseComponent {
  name: string;
}

export type Bump = "patch" | "minor" | "major";

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

const TAG_RE = /^([a-z0-9]+)\/v(\d+)\.(\d+)\.(\d+)$/;

export function parseTag(tag: string): { component: string; version: Semver } | null {
  const m = TAG_RE.exec(tag);
  return m ? { component: m[1]!, version: { major: +m[2]!, minor: +m[3]!, patch: +m[4]! } } : null;
}

export function formatVersion(v: Semver): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

export function parseVersion(s: string): Semver {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (!m) throw new Error(`version must be X.Y.Z, got "${s}"`);
  return { major: +m[1]!, minor: +m[2]!, patch: +m[3]! };
}

export function compareSemver(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** Highest `<component>/vX.Y.Z` tag among `tags`, by semver (not string) order; undefined if none. */
export function lastTag(component: string, tags: string[]): string | undefined {
  let best: { tag: string; v: Semver } | undefined;
  for (const tag of tags) {
    const p = parseTag(tag);
    if (!p || p.component !== component) continue;
    if (!best || compareSemver(p.version, best.v) > 0) best = { tag, v: p.version };
  }
  return best?.tag;
}

export function bumpVersion(v: Semver, bump: Bump): Semver {
  if (bump === "major") return { major: v.major + 1, minor: 0, patch: 0 };
  if (bump === "minor") return { major: v.major, minor: v.minor + 1, patch: 0 };
  return { major: v.major, minor: v.minor, patch: v.patch + 1 };
}

export const FIRST_VERSION: Semver = { major: 0, minor: 1, patch: 0 };

export interface ReleaseDeps {
  /** All tags in the repo. */
  tags(): string[];
  /** Files changed in <base>..HEAD (changedFiles from scripts/affected.mjs); null = unknown, which marks everything. */
  changedFiles(base: string | null): string[] | null;
  /** Components affected by these files (computeAffected(files, ...).components). */
  affected(files: string[] | null): string[];
  /** One-line commits in <base>..HEAD (all history when base is null). */
  commits(base: string | null): string[];
  /** Tags that point at the commit being released (HEAD). A component with one is already released there. */
  headTags?(): string[];
}

export interface ReleaseOptions {
  components: string[]; // all releasable components
  only?: string[]; // restrict to these
  bump?: Bump;
  version?: string; // explicit, applies to every selected component
}

export interface ReleaseItem {
  component: string;
  previousTag: string | null;
  version: string;
  tag: string;
  commits: string[];
  first: boolean;
}

/**
 * Files that cannot change a shipped artifact: CI config and scripts, tests, test/turbo config, the CLI and auto-tagger
 * (no component bundles them: nothing depends on @wolfpack/cli and the release build stages only the wolfd closure).
 * Docs need no rule here: computeAffected already ignores them. Lockfiles, root package.json/tsconfig, workspace config,
 * build/release recipes (scripts/release-*, scripts/build-*, infra/release/**) mark everything.
 * CI keeps using the unfiltered computeAffected.
 */
const NOT_SHIPPED = [
  /^\.github\//,
  /^scripts\/(auto-tag|affected)\./,
  /^packages\/cli\//,
  /\.(test|spec)\.[^/]+$/,
  /(^|\/)(tests|__tests__)\//,
  /^vitest\.[^/]+$/,
  /^turbo\.json$/,
];

/** Build and release recipes: computeAffected ignores them, but a change can alter every artifact. */
const REBUILDS_ALL = [/^scripts\/(release|build)-[^/]*$/, /^infra\/release\//];

/**
 * Non-code runtime assets a package ships (read relative to dist; infra/release/Dockerfile copies package.json "files").
 * computeAffected ignores *.md, so each is reported as a change to its package's package.json: the package and its
 * dependents tag. Only @wolfpack/agents lists such dirs.
 */
const SHIPPED_ASSETS = /^(packages\/agents)\/(agents|standards|prompts)\/.*/;

/** Files to feed computeAffected for a release; null (everything) when a build recipe changed. */
export function releaseFiles(changed: string[] | null): string[] | null {
  if (!changed || changed.some((f) => REBUILDS_ALL.some((r) => r.test(f)))) return null;
  return changed.filter((f) => !NOT_SHIPPED.some((r) => r.test(f))).map((f) => f.replace(SHIPPED_ASSETS, "$1/package.json"));
}

/** Changed components with their commits and the suggested next tag. Unchanged components are omitted. */
export function planRelease(opts: ReleaseOptions, deps: ReleaseDeps): ReleaseItem[] {
  const tags = deps.tags();
  const explicit = opts.version ? parseVersion(opts.version) : undefined;
  for (const o of opts.only ?? []) if (!opts.components.includes(o)) throw new Error(`unknown component "${o}" (releasable: ${opts.components.join(", ")})`);
  const headTags = deps.headTags?.() ?? [];
  const items: ReleaseItem[] = [];
  for (const component of opts.components) {
    if (opts.only?.length && !opts.only.includes(component)) continue;
    if (headTags.some((t) => parseTag(t)?.component === component)) continue;
    const prev = lastTag(component, tags) ?? null;
    // No tag yet counts as changed.
    if (prev) {
      const changed = deps.changedFiles(prev);
      // deploy/<component>/ (setup.sh, service, env example, runbook) is copied into that component's bundle, but is no workspace.
      const shipsDeploy = changed?.some((f) => f.startsWith(`deploy/${component}/`));
      if (!shipsDeploy && !deps.affected(releaseFiles(changed)).includes(component)) continue;
    }
    const prevV = prev ? parseTag(prev)!.version : undefined;
    const next = explicit ?? (prevV ? bumpVersion(prevV, opts.bump ?? "patch") : FIRST_VERSION);
    if (prevV && compareSemver(next, prevV) <= 0) throw new Error(`${component}: version ${formatVersion(next)} is not above ${prev}`);
    const version = formatVersion(next);
    const tag = `${component}/v${version}`;
    if (tags.includes(tag)) throw new Error(`tag ${tag} already exists`);
    items.push({ component, previousTag: prev, version, tag, commits: deps.commits(prev), first: !prev });
  }
  return items;
}

/** GitHub fires no tag workflows when one push carries more than 3 tags, so push each tag on its own. Never a branch. */
export function pushTagsSeparately(git: (...args: string[]) => unknown, remote: string, tags: string[]): void {
  for (const tag of tags) git("push", remote, `refs/tags/${tag}`);
}

export function formatPlan(items: ReleaseItem[]): string {
  if (!items.length) return "Nothing to release: no component changed since its last tag.";
  return items
    .map((i) => {
      const head = i.first ? `${i.component}: no tag yet -> ${i.tag} (first release)` : `${i.component}: ${i.previousTag} -> ${i.tag}`;
      const shown = i.commits.slice(0, 15).map((c) => `    ${c}`);
      if (i.commits.length > 15) shown.push(`    … and ${i.commits.length - 15} more`);
      return [head, `  ${i.commits.length} commit(s):`, ...shown].join("\n");
    })
    .join("\n\n");
}
