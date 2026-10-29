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
  DEFAULT_RULES, chooseSplit, isSplit, validatePartition, isPartition,
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
  cached?: boolean;
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
  const index = new Map(ids.map((id, i) => [id, i]));
  const asIdx = (xs: string[]) => xs.map((x) => index.get(x)).filter((i): i is number => i !== undefined);
  const result = validatePartition(vectors, {
    names: proposal.categories.map((c) => c.name),
    members: proposal.categories.map((c) => asIdx(c.ids)),
    doesntFit: asIdx(proposal.doesntFit),
  }, rules);
  const diag = deps.diagnostics ? kmeans() : undefined;
  if (!isPartition(result)) {
    deps.notify?.(`no split: ${result.reason}`);
    return { source: "llm", reason: result.reason, categories: result.categories, doesntFit: proposal.doesntFit, kmeans: diag, cached };
  }
  return {
    source: "llm",
    decision: { labels: result.labels, k: result.k, names: result.names, leftovers: result.leftovers },
    categories: result.categories, doesntFit: proposal.doesntFit, kmeans: diag, cached,
  };
}
export type { PartitionDecision };
