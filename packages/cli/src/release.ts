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
  /** Components changed in <base>..HEAD (computeAffected(...).components); base null = everything. */
  affected(base: string | null): string[];
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
    if (prev && !deps.affected(prev).includes(component)) continue;
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
