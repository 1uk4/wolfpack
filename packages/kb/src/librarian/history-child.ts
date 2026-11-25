/**
 * history-child — the History digest child of an over-cap anchored entry.
 *
 * The child is a normal entry (a minted `kb-<domain>-<id>`, never an anchor, no group, no source-* properties) in the
 * parent's domain and section. `historyOf: <parentId>` on the child and `historyChild: <childId>` on the parent are the
 * link; the parent's body keeps one pointer line (`History: see [[<childId>]]`). Shared by the sweep (produce-verbatim)
 * and the split-fat admin op so both write the same thing.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, parseFrontmatter } from "@wolfpack/engine";
import { type KbRoots, entriesDir, ev, type KbEvent } from "../shared/index.js";
import { contentHash } from "../shared/hash.js";
import { splitHistory } from "../shared/knowledgeLint.js";
import { entryHashText } from "./entry-hash.js";
import { historyLines } from "./preserve.js";
import type { Entry } from "../schema/knowledge.js";

const POINTER_LINE = /^History: see \[\[[^\]\n]*\]\][ \t]*\n?/gm;
const norm = (l: string) => l.replace(/\s+/g, " ").trim();

/** The pointer line an anchored parent keeps in place of its History. */
export const historyPointer = (childId: string): string => `History: see [[${childId}]]`;

/** The parent's History digest child id (`historyChild:` in its frontmatter), if any. */
export function historyChildIdOf(markdown: string | undefined | null): string | undefined {
  const fm = markdown ? /^---\n([\s\S]*?)\n---/.exec(markdown)?.[1] : undefined;
  const id = fm && /^historyChild:[ \t]*(\S+)[ \t]*$/m.exec(fm)?.[1];
  return id && /^kb-[a-z0-9]+-[0-9A-Za-z]{7}$/.test(id) ? id : undefined;
}

/** `detail` with every History line of `childMarkdown` that it lacks put back first (older lines go first). No fold limit: a digest may be long. */
export function mergeHistoryFrom(childMarkdown: string | undefined | null, detail: string): string {
  const old = childMarkdown ? historyLines(childMarkdown) : [];
  if (old.length === 0) return detail;
  const have = new Set(historyLines(detail).map(norm));
  const lost = old.filter((l) => !have.has(norm(l)));
  if (lost.length === 0) return detail;
  const { main, history } = splitHistory(detail);
  if (!history) return `${detail.trimEnd()}\n\n## History\n\n${lost.join("\n")}\n`;
  const rest = history.replace(/^## History[ \t]*\n*/, "");
  return `${main}## History\n\n${lost.join("\n")}\n${rest}`;
}

/**
 * Move the `## History` section of `detail` out into a child body and leave one pointer line.
 * With no History and `force` (the child already exists) only the pointer is kept.
 */
export function foldHistory(
  detail: string,
  o: { parentTitle: string; childId: string; date: string; force?: boolean },
): { detail: string; child?: { title: string; summary: string; body: string } } {
  const clean = detail.replace(POINTER_LINE, "");
  const { main, history } = splitHistory(clean);
  if (!history.trim()) return o.force ? { detail: `${clean.trimEnd()}\n\n${historyPointer(o.childId)}\n` } : { detail: clean };
  const parentTitle = o.parentTitle.trim(); // verbatimParts pads short titles to 3 chars
  return {
    detail: `${main.trimEnd()}\n\n${historyPointer(o.childId)}\n`,
    child: {
      title: `${parentTitle}: history digest (${o.date})`,
      summary: `History of ${parentTitle}, folded out to keep the entry under its size cap.`,
      body: history.trim(),
    },
  };
}

const yamlStr = (s: string): string => JSON.stringify(s);

export interface HistoryChildArgs {
  id: string;
  parentId: string;
  domain: string;
  /** The parent's section; the child sits beside it. */
  section: string;
  placement: { basis: string; fit: number };
  title: string;
  summary: string;
  body: string;
  date: string;
}

/** The child's markdown: no anchor, group or source-* properties; `historyOf` links to the parent. */
export function renderHistoryChild(a: HistoryChildArgs & { created: string }): string {
  return [
    "---",
    `id: ${a.id}`,
    `title: ${yamlStr(a.title)}`,
    `domain: ${a.domain}`,
    `historyOf: ${a.parentId}`,
    `section: ${a.section}`,
    "placement:",
    `  basis: ${a.placement.basis}`,
    `  fit: ${a.placement.fit.toFixed(3)}`,
    "kind: fact",
    "maturity: stub",
    "authority: curated",
    "confidence: high",
    "currency: live",
    `created: ${a.created}`,
    `updated: ${a.date}`,
    `contentHash: ${contentHash(entryHashText(a.title, a.summary, a.body))}`,
    "---",
    "",
    `# ${a.title}`,
    "",
    a.summary,
    "",
    a.body,
    "",
  ].join("\n");
}

/**
 * Write the child file (keeping its creation date when it exists) and return the ledger events for the caller to
 * append: written (create or merge) and, for a new child, placed in the parent's section.
 */
export function writeHistoryChild(roots: KbRoots, a: HistoryChildArgs): KbEvent[] {
  const dir = entriesDir(roots, a.domain);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${a.id}.md`);
  const exists = existsSync(file);
  const created = exists ? String(parseFrontmatter(readFileSync(file, "utf-8")).fields.created ?? a.date) : a.date;
  atomicWrite(file, renderHistoryChild({ ...a, created }));
  return [
    ev.entryWritten(a.id, a.id, exists ? "merge" : "create"),
    ...(exists ? [] : [ev.entryPlaced({ entryId: a.id, sectionId: a.section, basis: a.placement.basis as "routed", fit: a.placement.fit })]),
  ];
}

/** The entry with another detail (its content hash recomputed). `dropChild`: also forget the History child link. */
export function withDetail(entry: Entry, detail: string, dropChild = false): Entry {
  return {
    ...entry,
    detail,
    contentHash: contentHash(entryHashText(entry.title, entry.summary, detail)),
    ...(dropChild ? { historyChild: undefined } : {}),
  };
}
