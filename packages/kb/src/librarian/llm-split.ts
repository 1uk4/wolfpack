/**
 * llm-split — the split rule used by the rebuild and the insert path: an LLM PROPOSES how an oversized
 * section divides (2-5 categories plus "doesn't fit"), the section's vectors VALIDATE it
 * (tree-rules.validatePartition) and may drop members or categories. k-means (tree-rules.chooseSplit)
 * is only the fallback when the LLM call fails, and a diagnostic in the proposal.
 *
 * Determinism: members go to the model in id order with one fixed prompt, and the answer is cached by a
 * hash of the member set, so a re-run or an insert into the same set never asks again. (The validation
 * is pure and re-run each time.)
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWrite } from "@wolfpack/engine";
import type { Engine } from "@wolfpack/engine";
import { proposeSplit, type SplitMember, type SplitProposal } from "./summarize.js";
import {
  DEFAULT_RULES, chooseSplit, isSplit, validatePartition, isPartition, applyJoin,
  type CategoryReport, type PartitionDecision, type SplitDecision, type SplitRejected, type TreeRules, type Vec,
} from "./tree-rules.js";

export type { SplitProposal } from "./summarize.js";
export type Partitioner = (ctx: { parentTitle: string; members: SplitMember[] }) => Promise<SplitProposal>;

export interface SplitCache {
  get(key: string): SplitProposal | undefined;
  set(key: string, value: SplitProposal): void;
}
export function memorySplitCache(): SplitCache {
  const m = new Map<string, SplitProposal>();
  return { get: (k) => m.get(k), set: (k, v) => void m.set(k, v) };
}
/** A cache that survives processes (for the sweep's insert path): one JSON file, rewritten atomically on set. */
export function fileSplitCache(path: string): SplitCache {
  let data: Record<string, SplitProposal> = {};
  if (existsSync(path)) { try { data = JSON.parse(readFileSync(path, "utf-8")); } catch { data = {}; } }
  return {
    get: (k) => data[k],
    set: (k, v) => { data[k] = v; mkdirSync(dirname(path), { recursive: true }); atomicWrite(path, JSON.stringify(data)); },
  };
}
/**
 * Bump when SPLIT_SECTION_SYSTEM or the prompt layout in proposeSplit changes: cached answers were produced under the old
 * prompt, so they must not be served for the new one (the version is part of the cache key).
 */
export const PROMPT_VERSION = "split-v1";

/**
 * A cache a non-dry run may read but NEVER write to disk: reads fall through to the base (the proposals a dry run saved and the
 * owner reviewed); writes stay in an in-memory overlay so repeated member sets inside one plan are asked once. Only a dry run
 * populates the file, so an aborted or repeated `--yes` can never leave an unreviewed proposal behind for the next one to commit.
 */
export function readOnlyOverlay(base: SplitCache): SplitCache {
  const overlay = new Map<string, SplitProposal>();
  return { get: (k) => overlay.get(k) ?? base.get(k), set: (k, v) => void overlay.set(k, v) };
}

/** `--fresh-split`: reads miss (so the LLM is asked again) but writes go through, overwriting the stored entries. */
export function freshOrCached(cache: SplitCache, fresh: boolean): SplitCache {
  return fresh ? { get: () => undefined, set: (k, v) => cache.set(k, v) } : cache;
}

/** Cache key: the prompt version, the domain and the SORTED member ids (titles are not part of the key). */
export function splitCacheKey(domain: string, memberIds: string[]): string {
  return createHash("sha256").update(PROMPT_VERSION + "\u0000" + domain + "\u0000" + [...memberIds].sort().join("\u0000")).digest("hex").slice(0, 24);
}

/** A well-formed proposal: categories is an array of {name: string, ids: string[]}, doesntFit an array of strings. Anything else (a hand-edited or old cache file) is a cache miss. */
export function isValidProposal(p: unknown): p is SplitProposal {
  if (!p || typeof p !== "object") return false;
  const { categories, doesntFit } = p as { categories?: unknown; doesntFit?: unknown };
  if (!Array.isArray(categories) || !Array.isArray(doesntFit)) return false;
  if (!doesntFit.every((x) => typeof x === "string")) return false;
  return categories.every((c) => !!c && typeof c === "object" && typeof (c as { name?: unknown }).name === "string"
    && Array.isArray((c as { ids?: unknown }).ids) && (c as { ids: unknown[] }).ids.every((x) => typeof x === "string"));
}
export const enginePartitioner = (engine: Engine): Partitioner => ({ parentTitle, members }) => proposeSplit(engine, parentTitle, members);

export interface JudgeMember extends SplitMember { vector: Vec }
export interface JudgeDeps {
  partitioner?: Partitioner;
  cache?: SplitCache;
  rules?: TreeRules;
  /** Also run k-means beside the LLM partition, for the proposal. */
  diagnostics?: boolean;
  /** Evaluate sections at or below splitAbove too (eval only). */
  ignoreSize?: boolean;
  notify?: (msg: string) => void;
}
export interface SplitVerdict {
  /** Set when the section splits. `names` are the LLM's category names when the source is the LLM. */
  decision?: { labels: number[]; k: number; names?: string[]; leftovers: number[] };
  reason?: string;
  source: "llm" | "kmeans" | "none";
  /** Categories with their coherence (LLM source). */
  categories?: CategoryReport[];
  /** Doesn't-fit members of the LLM proposal. */
  doesntFit?: string[];
  /** Why the LLM path was not used (call failed). */
  fallbackReason?: string;
  /** k-means result beside the LLM one (diagnostics) or in its place (fallback). */
  kmeans?: SplitDecision | SplitRejected;
  /** Set when diagnostics were asked for but the section is above rules.diagnosticsMaxMembers. */
  kmeansSkipped?: string;
  cached?: boolean;
  /** Leftovers placed in their closest group by the join bar (LLM source). */
  joined?: number;
}

/**
 * Map the model's ids back to member indexes. Entry ids are "kb-<domain>-<short>" and the model sometimes answers with only the
 * short part ("h18Dpg5"); an exact match wins, else a bare id that is the unique "-"-suffix of a member id. Ids are trimmed once, up
 * front. Unknown or ambiguous ids are dropped, but reported ("N of M ids in category X did not map"): they used to vanish silently,
 * which turned a whole section's answer into "0 proposed".
 */
function idResolver(ids: string[], notify?: (msg: string) => void): (xs: string[], label: string) => number[] {
  const exact = new Map(ids.map((id, i) => [id, i]));
  const bySuffix = new Map<string, number | null>();
  ids.forEach((id, i) => {
    const short = id.slice(id.lastIndexOf("-") + 1);
    bySuffix.set(short, bySuffix.has(short) ? null : i);
  });
  return (xs, label) => {
    const out = xs.map((x) => x.trim()).map((x) => exact.get(x) ?? bySuffix.get(x) ?? undefined);
    const bad = out.filter((i) => i === undefined).length;
    if (bad > 0) notify?.(`${bad} of ${xs.length} ids in category ${label} did not map`);
    return out.filter((i): i is number => i !== undefined);
  };
}

/** Decide whether and how one oversized section splits. */
export async function judgeSplit(
  deps: JudgeDeps,
  args: { domain: string; parentTitle: string; members: JudgeMember[] }
): Promise<SplitVerdict> {
  const rules = deps.rules ?? DEFAULT_RULES;
  const members = [...args.members].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (members.length <= rules.splitAbove && !deps.ignoreSize) return { source: "none", reason: "below-threshold" };
  const ids = members.map((m) => m.id);
  const vectors = members.map((m) => m.vector);
  const kmeans = () => chooseSplit(vectors, ids, rules, { ignoreSize: true });
  const fromKmeans = (k: SplitDecision | SplitRejected, fallbackReason?: string): SplitVerdict =>
    isSplit(k)
      ? { source: "kmeans", decision: { labels: k.labels, k: k.k, leftovers: k.leftovers }, kmeans: k, fallbackReason }
      : { source: "kmeans", reason: k.reason, kmeans: k, fallbackReason };

  if (!deps.partitioner) return fromKmeans(kmeans());

  const key = splitCacheKey(args.domain, ids);
  let proposal = deps.cache?.get(key);
  if (proposal !== undefined && !isValidProposal(proposal)) {
    deps.notify?.("cached split proposal is malformed; treating it as a cache miss");
    proposal = undefined;
  }
  const cached = !!proposal;
  if (!proposal) {
    try {
      const fresh = await deps.partitioner({ parentTitle: args.parentTitle, members: members.map(({ id, title, summary }) => ({ id, title, summary })) });
      if (!isValidProposal(fresh)) throw new Error("the proposal is malformed (categories/doesntFit)");
      proposal = fresh;
      deps.cache?.set(key, proposal);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      deps.notify?.(`split proposal failed (${why}); falling back to k-means`);
      return fromKmeans(kmeans(), why);
    }
  }
  const asIdx = idResolver(ids, deps.notify);
  const result = validatePartition(vectors, {
    names: proposal.categories.map((c) => c.name),
    members: proposal.categories.map((c) => asIdx(c.ids, c.name)),
    doesntFit: asIdx(proposal.doesntFit, "doesn't fit"),
  }, rules);
  const diagSkipped = deps.diagnostics && members.length > rules.diagnosticsMaxMembers
    ? `k-means comparison skipped: ${members.length} members > ${rules.diagnosticsMaxMembers}` : undefined;
  const diag = deps.diagnostics && !diagSkipped ? kmeans() : undefined;
  if (!isPartition(result) && result.single) {
    // One category survived: the leftovers may hold its partner.
    const two = await secondPass(deps, rules, args, members, vectors, result.single);
    if (two.d.k >= 2) {
      const j = applyJoin(vectors, two.d, rules);
      return {
        source: "llm", decision: { labels: j.d.labels, k: j.d.k, names: j.d.names, leftovers: j.d.leftovers }, joined: j.joined,
        categories: two.d.categories, doesntFit: proposal.doesntFit, kmeans: diag, kmeansSkipped: diagSkipped, cached: cached && !two.asked,
      };
    }
  }
  if (!isPartition(result)) {
    deps.notify?.(`no split: ${result.reason}`);
    return { source: "llm", reason: result.reason, categories: result.categories, doesntFit: proposal.doesntFit, kmeans: diag, kmeansSkipped: diagSkipped, cached };
  }
  const final = await secondPass(deps, rules, args, members, vectors, result);
  const j = applyJoin(vectors, final.d, rules);
  return {
    source: "llm", joined: j.joined,
    decision: { labels: j.d.labels, k: j.d.k, names: j.d.names, leftovers: j.d.leftovers },
    categories: final.d.categories, doesntFit: proposal.doesntFit, kmeans: diag, kmeansSkipped: diagSkipped, cached: cached && !final.asked,
  };
}

/**
 * ONE more grouping pass over what the first pass left on the parent (leftovers fitting no group). The model is asked about the
 * leftovers alone; its categories are then validated together with the groups already kept, so a new group must be closer to its
 * own members than to every kept group (and has at least minGroup coherent members). A failed call or a pass that adds nothing
 * leaves the first result as it was. The answer is cached under its own key (the leftover set, salted); `asked` is true when the
 * model was called (a cache miss).
 *
 * Total cap: the two passes together yield at most rules.llmMaxCategoriesTotal groups (the per-answer cap llmMaxCategories applies to
 * each pass on its own). Every first-pass group must survive the joint validation with at least its original members; otherwise the
 * first result is kept. The returned categories are the first pass's reports (dropped ones included) followed by the second pass's.
 */
async function secondPass(
  deps: JudgeDeps, rules: TreeRules, args: { domain: string; parentTitle: string }, members: JudgeMember[], vectors: Vec[], first: PartitionDecision,
): Promise<{ d: PartitionDecision; asked: boolean }> {
  const keepFirst = (asked: boolean) => ({ d: first, asked });
  if (!deps.partitioner || first.leftovers.length < rules.minGroup) return keepFirst(false);
  const left = first.leftovers.map((i) => members[i]);
  const leftIds = left.map((m) => m.id);
  const key = splitCacheKey(args.domain + "#leftovers", leftIds);
  let proposal = deps.cache?.get(key);
  if (proposal !== undefined && !isValidProposal(proposal)) {
    deps.notify?.("cached leftover proposal is malformed; treating it as a cache miss");
    proposal = undefined;
  }
  const asked = !proposal;
  if (!proposal) {
    try {
      const fresh = await deps.partitioner({
        parentTitle: `${args.parentTitle} (entries that fit none of its other groups)`,
        members: left.map(({ id, title, summary }) => ({ id, title, summary })),
      });
      if (!isValidProposal(fresh)) throw new Error("the proposal is malformed (categories/doesntFit)");
      proposal = fresh;
      deps.cache?.set(key, proposal);
    } catch (err) {
      deps.notify?.(`leftover grouping failed (${err instanceof Error ? err.message : String(err)}); keeping the first pass`);
      return keepFirst(true);
    }
  }
  const asIdx = idResolver(leftIds, deps.notify);
  const keptGroups = first.names.map((_, g) => first.labels.flatMap((l, i) => (l === g ? [i] : [])));
  const newGroups = proposal.categories.map((c) => asIdx(c.ids, c.name).map((j) => first.leftovers[j]));
  const total = keptGroups.length + newGroups.length;
  const both = validatePartition(vectors, {
    names: [...first.names, ...proposal.categories.map((c) => c.name)],
    members: [...keptGroups, ...newGroups],
    doesntFit: [],
  }, { ...rules, llmMaxCategories: Math.max(rules.llmMaxCategories, Math.min(total, rules.llmMaxCategoriesTotal)) });
  if (!isPartition(both) || both.k <= first.k || both.k > rules.llmMaxCategoriesTotal) return keepFirst(asked);
  // Every first-pass group must still hold its original members (compared by members, not names: a second-pass category may reuse a name).
  const survives = keptGroups.every((ms) => ms.length > 0 && new Set(ms.map((i) => both.labels[i])).size === 1 && both.labels[ms[0]] >= 0);
  if (!survives) return keepFirst(asked);
  deps.notify?.(`second pass over ${left.length} leftovers added ${both.k - first.k} group(s)`);
  return { d: { ...both, categories: [...first.categories, ...both.categories.slice(first.k)] }, asked };
}
export type { PartitionDecision };
