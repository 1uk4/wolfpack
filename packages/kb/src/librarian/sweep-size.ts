/**
 * sweep-size — the sweep's size rules, split out of sweep.ts: the merge-target size limit, the verbatim-anchor
 * exemption from the size guard, the "kept oversize" handling, the anchor History fold and the `~split-` placement decision.
 * One body cap (BODY_CAP) drives all of them.
 */
import { dirname, join } from "node:path";
import type { ParsedContribution } from "../shared/index.js";
import { BODY_CAP, splitHistory } from "../shared/knowledgeLint.js";
import { contentHash } from "../shared/hash.js";

export { BODY_CAP };

/** An anchored entry is a pinned record and is never split; past this many chars its History is folded into a child entry. */
export const ANCHOR_BODY_CAP = 12_000;

/**
 * Merge targets over twice the body cap are not merged into. The limit no longer derives from the run budget:
 * it is a property of the entry (BODY_CAP * 2), so the argument is accepted for call-site compatibility and ignored.
 */
export function maxMergeTargetCharsFor(_itemBudgetMs: number): number {
  return BODY_CAP * 2;
}

/** The merge size limit, with the KB_MAX_MERGE_TARGET_CHARS override. */
export function mergeSizeLimit(maxMergeTargetChars: number): number {
  return Number(process.env.KB_MAX_MERGE_TARGET_CHARS) || maxMergeTargetChars;
}

/** A verbatim anchored entry is replaced whole, not merged: the size guard does not apply. */
export function exemptFromSizeGuard(c: Pick<ParsedContribution, "anchor" | "verbatim">): boolean {
  return !!(c.anchor && c.verbatim);
}

/** The pointer line an anchored parent keeps in place of its History. */
export const historyPointer = (childId: string): string => `History: see [[${childId}]]`;

/**
 * Fold an entry's `## History` section out of its detail into a child entry. Returns the parent's detail with a
 * one-line pointer, and the child (never an anchor: it has no anchor field). No History: nothing to fold.
 */
export function foldHistory(
  detail: string,
  o: { parentTitle: string; childId: string; date: string },
): { detail: string; child?: { id: string; title: string; summary: string; body: string } } {
  const { main, history } = splitHistory(detail);
  if (!history.trim()) return { detail };
  const parentTitle = o.parentTitle.trim(); // verbatimParts pads short titles to 3 chars
  const title = `${parentTitle}: history digest (${o.date})`;
  return {
    detail: `${main.trimEnd()}\n\n${historyPointer(o.childId)}\n`,
    child: { id: o.childId, title, summary: `History of ${parentTitle}, folded out to keep the entry under its size cap.`, body: history.trim() },
  };
}

/**
 * The `~split-` contributions for a non-anchor entry produce kept over BODY_CAP: its `## ` sections past the first
 * BODY_CAP chars, one contribution each. One level only: a part that is itself over cap (denTopicId has `~split-`),
 * an anchored entry, or an entry with nothing to cut at, yields none and is kept with the "kept oversize" note.
 * `keep` is the detail the entry should be trimmed to.
 */
export function oversizeSplits(
  c: ParsedContribution,
  entry: { detail: string },
): { parts: ParsedContribution[]; keep: string } {
  if (c.anchor || c.denTopicId.includes("~split-")) return { parts: [], keep: entry.detail };
  const { main, history } = splitHistory(entry.detail);
  if (main.length <= BODY_CAP) return { parts: [], keep: entry.detail };
  const sections = main.split(/^(?=## )/m);
  let keep = "";
  const rest: string[] = [];
  for (const s of sections) {
    if (rest.length === 0 && (keep === "" || keep.length + s.length <= BODY_CAP)) keep += s;
    else rest.push(s);
  }
  if (rest.length === 0) return { parts: [], keep: entry.detail };
  const parts = rest.map((s) => {
    const title = (/^##[ \t]+(.+)$/m.exec(s)?.[1] ?? "Overflow").trim();
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "overflow";
    const body = `# ${title}\n\n${s.replace(/^##[ \t]+.+\n/, "").trim()}`.trim();
    const denTopicId = `${c.denTopicId}~split-${slug}`;
    return {
      ...c,
      denTopicId,
      change: "create" as const,
      contentHash: contentHash(body),
      prevHash: null,
      summary: title,
      body,
      anchor: undefined,
      target: undefined,
      filePath: join(dirname(c.filePath), `${denTopicId}.md`),
    };
  });
  return { parts, keep: `${keep.trimEnd()}${history ? `\n\n${history}` : "\n"}` };
}

/**
 * Notify when produce kept an entry oversize, and return the `~split-` contributions to enqueue for it
 * (empty when `detail` is not given, the entry is anchored, or it is already a split part).
 */
export function notifyKeptOversize(
  notify: ((msg: string) => void) | undefined,
  c: ParsedContribution | Pick<ParsedContribution, "from" | "denTopicId">,
  entryId: string,
  oversizeChars: number | undefined,
  detail?: string,
): ParsedContribution[] {
  if (!oversizeChars) return [];
  const parts = detail !== undefined && "filePath" in c ? oversizeSplits(c, { detail }).parts : [];
  if (parts.length) notify?.(`sweep: ${c.from}/${c.denTopicId} → ${entryId} ${oversizeChars} chars: ${parts.length} section(s) queued as ~split- parts`);
  else notify?.(`sweep: ${c.from}/${c.denTopicId} → kept oversize: ${entryId} ${oversizeChars}`);
  return parts;
}

/**
 * The boolean place() calls `overflowOk`: whether produce may split a second subject out of this contribution.
 * It is NOT a routing switch (split parts already go through routing and placement like any new contribution);
 * it bounds the split to one level, so a `~split-` part may not split again. It stays false for parts.
 */
export function shouldRoutePlacement(c: Pick<ParsedContribution, "denTopicId">): boolean {
  return !c.denTopicId.includes("~split-");
}
