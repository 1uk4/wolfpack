/**
 * `wolfpack pr prepare`: open (or update) the release PR from the current `wolf/<wolf>` branch into `stable`.
 * The owner merges it on GitHub with a merge commit; this code never merges a PR and never pushes `stable`.
 * Git, gh, the build and the work API are injected (PrDeps) so the orchestration is tested against fakes.
 */
import { PR_BODY_LIMIT, parseFeatureDoc, releaseBody, releaseTitle, type ReleaseFeature } from "./release-pr.js";

export interface WorkItemInfo {
  id: string;
  kind: string;
  title: string;
  partOf?: string | null;
}

/** A finished command: exit code with stdout and stderr kept apart (read `out` for values, show `err` to people). */
export interface CmdResult {
  code: number;
  out: string;
  err: string;
}

export interface PrDeps {
  /** Runs git (read-only calls included); never throws, reports the exit code. */
  git(args: string[]): CmdResult;
  /** Runs gh; `input` goes to stdin. */
  gh(args: string[], input?: string): CmdResult;
  /** Build + typecheck + the full suite of affected packages (the whole suite with `full`). */
  verify(opts: { base: string; full: boolean; skipLive: boolean }): Promise<{ ok: boolean; summary: string; live: string }>;
  /** Whether the Work API is configured (endpoint and key). Checked first, so a missing config refuses before anything changes. */
  workConfigured(): boolean;
  /** `GET /work/:id`: the item and its markdown body; null when unknown. Throws when the API cannot be reached. */
  work(id: string): Promise<{ item: WorkItemInfo; body: string | null } | null>;
  now(): Date;
  log(line: string): void;
}

export interface PrPrepareOptions {
  full?: boolean;
  /** Do not run `test:live` before opening the PR; the PR body says so. */
  skipLive?: boolean;
  dryRun?: boolean;
  /** Anything but "stable" is refused. */
  base?: string;
}

export class PrRefusal extends Error {}

/** Files that build and dev tooling rewrite; they never make a tree dirty. One list for prepare and post-merge (scripts/runtime-update.mjs keeps its own copy, and a test checks they match). */
export const GENERATED_FILES = ["apps/console/next-env.d.ts"];

/** Whether `git status --porcelain` output names a change that is not a generated file. Pass the output untrimmed: the first column can be a space. */
export function hasRealChanges(porcelain: string): boolean {
  return porcelain
    .split("\n")
    .filter(Boolean)
    .some((l) => !GENERATED_FILES.includes(l.slice(3)));
}

/** The PR exists but its overflow comments could not be written; the message says so and to re-run. */
export class PrCommentsFailed extends PrRefusal {}

const MARKER_RE = /^<!-- wolfpack-release-part:(\d+) -->/;
const marker = (n: number) => `<!-- wolfpack-release-part:${n} -->`;
const size = (text: string) => Buffer.byteLength(text, "utf8");

interface MarkedComment {
  id: string;
  n: number;
}

interface CommentPlan {
  /** Part numbers (1-based) with no comment yet. */
  create: number[];
  edit: MarkedComment[];
  remove: MarkedComment[];
}

/** Which of the PR's existing marked comments to edit in place, and which leftovers (surplus parts, duplicates) to delete. */
function planComments(existing: MarkedComment[], count: number): CommentPlan {
  const plan: CommentPlan = { create: [], edit: [], remove: [] };
  const kept = new Map<number, MarkedComment>();
  for (const c of [...existing].sort((a, b) => a.n - b.n || Number(a.id) - Number(b.id))) {
    if (c.n >= 1 && c.n <= count && !kept.has(c.n)) kept.set(c.n, c);
    else plan.remove.push(c);
  }
  for (let n = 1; n <= count; n++) {
    const have = kept.get(n);
    if (have) plan.edit.push(have);
    else plan.create.push(n);
  }
  return plan;
}

const USAGE = "Usage: wolfpack pr prepare [--full] [--skip-live] [--dry-run] [--base stable]";

/**
 * The arguments of `wolfpack pr prepare`, from the raw argv after the node and script names. The global flag layer in the
 * bin swallows some flags (--host, --yes, ...) and passes the rest through unchecked, so this sees everything and accepts
 * only --full, --skip-live, --dry-run and --base <value>. The command words may sit anywhere.
 */
export function parsePrArgs(argv: string[]): { full: boolean; dryRun: boolean; skipLive: boolean; base: string | undefined } {
  const rest = [...argv];
  for (const word of ["pr", "prepare"]) {
    const i = rest.indexOf(word);
    if (i >= 0) rest.splice(i, 1);
  }
  const out = { full: false, dryRun: false, skipLive: false, base: undefined as string | undefined };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--full") out.full = true;
    else if (a === "--skip-live") out.skipLive = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--base") {
      const v = rest[++i];
      if (v === undefined || v.startsWith("-")) throw new PrRefusal(`--base needs a value. ${USAGE}`);
      out.base = v;
    } else throw new PrRefusal(`unknown argument "${a}". ${USAGE}`);
  }
  return out;
}

/** The file and test totals line(s) of a vitest summary, e.g. "Test Files 25 passed (25); Tests 195 passed (195)". */
export function parseTotals(output: string): string | undefined {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
  const files = /^\s*Test Files\s+(.+)$/m.exec(clean)?.[1]?.trim();
  const tests = /^\s*Tests\s+(.+)$/m.exec(clean)?.[1]?.trim();
  const parts = [files && `Test Files ${files}`, tests && `Tests ${tests}`].filter(Boolean);
  return parts.length ? parts.join("; ") : undefined;
}

const WORK_ID = /work-[a-z0-9]+-[A-Za-z0-9]+/g;
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const GITHUB_SLUG = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/;

const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)$/;

/** The repo ("owner/repo") and number a PR URL names, or undefined when it is not a github.com pull request URL. */
function parsePrUrl(url: string): { slug: string; number: string } | undefined {
  const m = PR_URL.exec(url.trim());
  return m ? { slug: m[1]!, number: m[2]! } : undefined;
}

const LOGIN = /^[A-Za-z0-9-]+(\[bot\])?$/;

/**
 * The PR's comments that we wrote: authored by the authenticated user and starting with our marker. Anyone else's comment,
 * even one that starts with the marker, is never returned, so it is never edited or deleted. The author is compared here in
 * TypeScript on the JSON gh prints, not inside a jq program, so the login never has to be quoted into a filter.
 */
function listMarked(gh: PrDeps["gh"], slug: string, pr: string): MarkedComment[] {
  const who = gh(["api", "user", "--jq", ".login"]);
  const me = who.out.trim();
  if (who.code !== 0 || !LOGIN.test(me)) throw new PrRefusal(`could not read the authenticated GitHub login (got ${JSON.stringify(me.slice(0, 40))}): ${detail(who)}`);
  const r = gh(["api", "--paginate", `repos/${slug}/issues/${pr}/comments`, "--jq", ".[] | [.id, .user.login, (.body | .[0:64])] | @json"]);
  if (r.code !== 0) throw new PrRefusal(`could not list the comments of PR #${pr}: ${detail(r)}`);
  const found: MarkedComment[] = [];
  for (const line of r.out.split("\n")) {
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Array.isArray(row)) continue;
    const [id, login, body] = row as unknown[];
    const n = typeof body === "string" ? MARKER_RE.exec(body)?.[1] : undefined;
    // The id goes into a request path, so only a plain number is accepted.
    if (login === me && n !== undefined && /^\d+$/.test(String(id))) found.push({ id: String(id), n: Number(n) });
  }
  return found;
}

const detail = (r: CmdResult) => (r.err.trim() || r.out.trim()).split("\n").slice(0, 8).join("\n");

function must(r: CmdResult, what: string): string {
  if (r.code !== 0) throw new PrRefusal(`${what} failed: ${detail(r)}`);
  return r.out.trim();
}

export async function prPrepare(opts: PrPrepareOptions, deps: PrDeps): Promise<void> {
  const { git, gh, log } = deps;
  if (opts.base !== undefined && opts.base !== "stable") throw new PrRefusal(`release PRs go into stable only, not "${opts.base}"`);
  const branch = must(git(["rev-parse", "--abbrev-ref", "HEAD"]), "git rev-parse");
  const match = /^wolf\/([^/]+)$/.exec(branch)?.[1];
  if (!match) throw new PrRefusal(`run this from a wolf/<wolf> branch (on "${branch}")`);
  const wolf: string = match;
  const status = git(["status", "--porcelain"]);
  if (status.code !== 0) throw new PrRefusal(`git status failed: ${detail(status)}`);
  if (hasRealChanges(status.out)) throw new PrRefusal("the working tree is dirty: commit or remove your changes first");
  if (gh(["auth", "status", "--hostname", "github.com"]).code !== 0) throw new PrRefusal("gh is not authenticated for github.com: run `gh auth login`");
  if (!deps.workConfigured()) throw new PrRefusal("Work API not configured (set WORK_ENDPOINT and WORK_TOKEN); nothing was changed");

  // Is there already an open PR for this branch? Anything but a number, "null" or nothing is an error, before anything changes.
  const lookup = gh(["pr", "list", "--head", branch, "--base", "stable", "--state", "open", "--json", "url", "--jq", ".[0].url"]);
  if (lookup.code !== 0) throw new PrRefusal(`could not look up an existing pull request: ${detail(lookup)}`);
  const found = lookup.out.trim();
  const prRef = parsePrUrl(found);
  if (found !== "" && found !== "null" && !prRef) throw new PrRefusal(`unexpected answer from the existing pull request lookup: "${found.slice(0, 80)}"`);
  const existing = prRef?.number;

  // Sync: stable must be an ancestor, so the PR merges cleanly. A merge commit, never a rebase.
  let merged = false;
  let pushed = false;
  if (opts.dryRun) log("dry run: not fetching; using the local origin/stable");
  else must(git(["fetch", "origin", "+refs/heads/stable:refs/remotes/origin/stable"]), "git fetch origin stable");
  const ancestor = git(["merge-base", "--is-ancestor", "origin/stable", "HEAD"]);
  // Exit 1 means "not an ancestor"; anything else non-zero is a real failure (e.g. origin/stable is missing).
  if (ancestor.code > 1) throw new PrRefusal(`git merge-base --is-ancestor failed: ${detail(ancestor)}`);
  if (ancestor.code === 1) {
    if (opts.dryRun) log("dry run: would run `git merge --no-edit origin/stable`");
    else {
      const m = git(["merge", "--no-edit", "origin/stable"]);
      if (m.code !== 0) {
        if (git(["rev-parse", "-q", "--verify", "MERGE_HEAD"]).code !== 0) throw new PrRefusal(`merging origin/stable into ${branch} failed (not a conflict):\n${detail(m)}`);
        const abort = git(["merge", "--abort"]);
        if (abort.code !== 0) {
          throw new PrRefusal(
            `merging origin/stable into ${branch} conflicts, and \`git merge --abort\` failed, so the repo is mid-merge. ` +
              `Run \`git status\`, then \`git merge --abort\` by hand (or resolve the conflicts and commit).\ngit said: ${detail(abort)}\nthe merge said:\n${detail(m)}`,
          );
        }
        throw new PrRefusal(`merging origin/stable into ${branch} conflicts; the merge was aborted. Resolve it by hand, then run prepare again.\n${detail(m)}`);
      }
      merged = true;
    }
  }

  try {
    await finish();
  } catch (err) {
    if (err instanceof PrCommentsFailed) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (!(err instanceof PrRefusal)) log(`internal error:\n${err instanceof Error ? (err.stack ?? msg) : msg}`);
    const note = pushed
      ? `\n${branch} was pushed, but opening the pull request failed. Run prepare again.`
      : merged
        ? `\norigin/stable was merged into ${branch} locally; nothing was pushed.`
        : "";
    throw new PrRefusal(msg + note);
  }

  async function finish(): Promise<void> {
    const previousStable = must(git(["rev-parse", "origin/stable"]), "git rev-parse origin/stable");
    const head = must(git(["rev-parse", "HEAD"]), "git rev-parse HEAD");
    const commits = must(git(["log", "--no-merges", "--format=%h\t%s", "origin/stable..HEAD"]), "git log")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [sha = "", ...rest] = l.split("\t");
        return `${sha} ${rest.join("\t")}`;
      });
    if (!commits.length) throw new PrRefusal("nothing to release: no commits on this branch beyond origin/stable");

    // Work items, each looked up once. A missing or unreachable item is a warning, and its commit goes under Other commits.
    const cache = new Map<string, ReturnType<PrDeps["work"]>>();
    const warned = new Set<string>();
    const unreadable = new Set<string>();
    const item = (id: string) => {
      let p = cache.get(id);
      if (!p) {
        p = deps.work(id).catch((e: unknown) => {
          if (e instanceof PrRefusal) throw e;
          warned.add(id);
          unreadable.add(id);
          log(`warning: could not read ${id} from the work API: ${e instanceof Error ? e.message : String(e)}`);
          return null;
        });
        cache.set(id, p);
      }
      return p;
    };
    /** The feature a work id belongs to: itself when it is a feature, else the nearest feature up its partOf chain. */
    const featureOf = async (id: string, seen = new Set<string>()): Promise<string | null> => {
      if (seen.has(id)) {
        log(`warning: ${id} is in a loop of partOf links`);
        return null;
      }
      seen.add(id);
      const w = await item(id);
      if (!w) {
        if (!warned.has(id)) log(`warning: ${id} not found in the work API`);
        warned.add(id);
        return null;
      }
      if (w.item.kind === "feature") return w.item.id;
      return w.item.partOf ? featureOf(w.item.partOf, seen) : null;
    };

    const featureIds = new Set<string>();
    const other: string[] = [];
    for (const line of commits) {
      const ids = line.match(WORK_ID) ?? [];
      if (!ids.length) log(`warning: commit without a work item ID: ${line}`);
      const feats = new Set<string>();
      for (const id of ids) {
        const f = await featureOf(id);
        if (f) feats.add(f);
      }
      if (!feats.size) other.push(line);
      for (const f of feats) featureIds.add(f);
    }

    // The PR's own repo when it exists (that is where comments go too); otherwise the origin's.
    const slug = prRef?.slug ?? GITHUB_SLUG.exec(git(["remote", "get-url", "origin"]).out.trim())?.[1];
    const features: ReleaseFeature[] = [];
    for (const id of featureIds) {
      const w = await item(id);
      const parsed = parseFeatureDoc(w?.body);
      // Only tracked files are listed, so ignored files are never linked; a clean tree means none are merely untracked.
      const ls = git(["ls-files", "-z", "--", `docs/pr-assets/${id}/`]);
      const files = ls.code === 0 ? ls.out.split("\0").filter((f) => IMAGE.test(f)).sort() : [];
      const links = slug ? files.map((f) => `https://github.com/${slug}/blob/${head}/${f.split("/").map(encodeURIComponent).join("/")}?raw=true`) : [];
      features.push({
        id,
        title: w?.item.title ?? id,
        risk: parsed.risk,
        manualChecks: parsed.manualChecks,
        diagram: parsed.diagram,
        screenshots: links,
        screenshotsNote: files.length && !slug ? "link unavailable (no GitHub remote)" : undefined,
        document: parsed.document,
      });
    }

    let tests: string;
    let live = "not run (dry run)";
    if (opts.dryRun) tests = "not run (dry run)";
    else {
      // A crash in the build step is turned into a clean refusal by the handler around finish().
      const v = await deps.verify({ base: "origin/stable", full: !!opts.full, skipLive: !!opts.skipLive });
      if (!v.ok) throw new PrRefusal(`build, typecheck or tests failed; no PR opened.\n${v.summary}`);
      tests = v.summary;
      live = v.live;
    }

    const input = {
      wolf,
      date: deps.now().toISOString().slice(0, 10),
      previousStable,
      features,
      otherCommits: other,
      tests,
      unreadable: [...unreadable].sort(),
      ci: "see the checks on this PR",
      liveEval: `live tests ${live}; eval tests run on the release PR's CI`,
    };
    const title = releaseTitle(input);
    const { body, comments } = releaseBody(input);
    const push = ["push", "origin", `refs/heads/${branch}:refs/heads/${branch}`];
    const ghWrite = existing
      ? ["pr", "edit", existing, "--title", title, "--body-file", "-"]
      : ["pr", "create", "--base", "stable", "--head", branch, "--title", title, "--body-file", "-"];
    const texts = comments.map((c, k) => `${marker(k + 1)}\n${c}`);

    // The builder moves and splits everything that can grow with the release, so this should be impossible. It is checked
    // anyway, here and before the push, because GitHub would otherwise reject the PR or a comment after the branch is pushed.
    const over = [["body", body], ...texts.map((t, k) => [`comment ${k + 1}`, t] as const)].filter(([, t]) => size(t!) > PR_BODY_LIMIT);
    if (over.length) {
      throw new PrRefusal(`${over.map(([what, t]) => `the ${what} is ${size(t!)} bytes`).join(", ")}, over the ${PR_BODY_LIMIT}-byte limit GitHub accepts; nothing was pushed`);
    }

    if (opts.dryRun) {
      const plan = planComments(prRef ? listMarked(gh, prRef.slug, prRef.number) : [], texts.length);
      log(`# ${title}\n\n${body}`);
      log(`dry run: would run\n  git ${push.join(" ")}\n  gh ${ghWrite.join(" ")}\nNothing was fetched, merged, pushed or opened.`);
      log(
        [
          `body: ${size(body)} bytes`,
          `overflow comments: would create ${plan.create.length}, edit ${plan.edit.length}, delete ${plan.remove.length}`,
          ...texts.map((t, k) => `  comment ${k + 1}: ${size(t)} bytes`),
        ].join("\n"),
      );
      return;
    }
    must(git(push), "git push");
    pushed = true;
    const url = must(gh(ghWrite, body), "gh pr").split("\n").pop() ?? "";
    log(url);
    const made = prRef ?? parsePrUrl(url);
    if (texts.length || existing) {
      try {
        if (!made) throw new PrRefusal(`could not read the repository and number from gh's answer "${url.slice(0, 80)}"`);
        syncComments(made.slug, made.number, texts);
      } catch (err) {
        throw new PrCommentsFailed(`PR ${url} opened/updated; overflow comments failed: ${err instanceof Error ? err.message : String(err)}; re-run prepare`);
      }
    }
    log("The owner merges this on GitHub with a merge commit. prepare never merges.");
  }

  /** Write the overflow comments in place: edit our marked ones, create the missing, delete leftovers. gh api with arg arrays; bodies on stdin. */
  function syncComments(slug: string, pr: string, texts: string[]): void {
    const plan = planComments(listMarked(gh, slug, pr), texts.length);
    const byN = new Map(plan.edit.map((c) => [c.n, c.id]));
    for (let n = 1; n <= texts.length; n++) {
      const id = byN.get(n);
      const args = id ? ["api", "-X", "PATCH", `repos/${slug}/issues/comments/${id}`, "--input", "-"] : ["api", "-X", "POST", `repos/${slug}/issues/${pr}/comments`, "--input", "-"];
      must(gh(args, JSON.stringify({ body: texts[n - 1] })), "gh api");
    }
    for (const c of plan.remove) must(gh(["api", "-X", "DELETE", `repos/${slug}/issues/comments/${c.id}`]), "gh api");
  }
}
