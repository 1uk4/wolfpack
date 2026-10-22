/**
 * rollup — fold a shipped child's outcome into its parent feature's `## Outcomes`.
 *
 * Document-driven, LLM-free. EVERY feature gets an `## Outcomes` section
 * (created at the end of its document on the first ship) holding the
 * `<!-- rollup:children -->…<!-- /rollup:children -->` zone. A shipped task
 * contributes its `## Rollup` section verbatim when it has one, else one line
 * "<title>, shipped <YYYY-MM-DD>". Only that zone is written; the rest of the
 * document stays byte for byte.
 *
 * Legacy features that already carry a children zone elsewhere (a sprint log)
 * keep it as their Outcomes: there a child without a `## Rollup` section is
 * lifted whole, as before. An optional
 * `<!-- rollup:totals keys="A,B,C" -->…<!-- /rollup:totals -->` block sums
 * numeric `Key: value [unit]` lines across all rolled-up children.
 *
 * Contract:
 *   Parent body:
 *     ## Entries
 *     <!-- rollup:children -->
 *     <!-- /rollup:children -->
 *
 *     ## Totals
 *     <!-- rollup:totals keys="Tasks,Files,Duration" -->
 *     <!-- /rollup:totals -->
 *
 *   Child body: either a `## Rollup` section (preferred) or the whole body
 *   below the H1. The entire chosen region is lifted verbatim as the child's
 *   distilled block.
 *
 *   Totals keys parse any `Key: value [unit]` fragment on any line of a child
 *   block. Values parse as numbers (commas allowed), with a few unit shapes:
 *     "H:MM" → minutes          ("1:44"      → 104)
 *     "N min" / "N minutes"     ("50 min"    → 50)
 *     "N lb" / "N kg"           ("21,300 lb" → 21300, unit = "lb")
 *     bare number               ("20"        → 20)
 *   Mixed-unit keys render with the first non-trivial unit seen (e.g. "lb").
 *   Totals rendering reverses H:MM for keys called "Duration" or ending in
 *   "duration" / "time".
 */

import { findSection } from "../work-record.js";

export const OUTCOMES_HEADING = "## Outcomes";

// ── Marker syntax ────────────────────────────────────────────────────────
const CHILDREN_OPEN = "<!-- rollup:children -->";
const CHILDREN_CLOSE = "<!-- /rollup:children -->";
const TOTALS_OPEN_RE =
  /<!--\s*rollup:totals\s+keys="([^"]+)"\s*-->/;
const TOTALS_CLOSE = "<!-- /rollup:totals -->";
const ITEM_OPEN_RE =
  /<!--\s*rollup:item\s+id=([a-zA-Z0-9_-]+)\s+when=(\d{4}-\d{2}-\d{2})\s*-->/g;
const ITEM_CLOSE = "<!-- /rollup:item -->";

// ── Public: extract distilled content from a child task body ─────────────

/**
 * Pick the region of a task body that represents its "distilled" account.
 *
 * Order of preference:
 *   1. A `## Rollup` section (up to the next `## ` or EOF). Explicit, wins.
 *   2. Whole body minus the leading `# <title>` line.
 *
 * Returned with trailing whitespace trimmed. Empty string if nothing usable.
 */
export function extractDistilled(body: string): string {
  if (!body) return "";

  // 1) explicit ## Rollup section — locate the header, then slice to the next
  //    H1/H2 at start-of-line or EOS. Avoids /m-flag `$` ambiguity.
  const headerRe = /(?:^|\n)##\s+Rollup[^\n]*\n/;
  const h = body.match(headerRe);
  if (h && h.index !== undefined) {
    const headerEnd = h.index + h[0].length;
    const after = body.slice(headerEnd);
    const nextSection = after.search(/(?:^|\n)#{1,2} /);
    const end = nextSection >= 0 ? headerEnd + nextSection : body.length;
    return body.slice(headerEnd, end).trim();
  }

  // 2) whole body minus leading H1, minus empty template sections
  //    ("## Plan" with nothing under it) so an untouched task reads as empty.
  let b = body;
  const h1 = b.match(/^#\s+[^\n]*\n/);
  if (h1) b = b.slice(h1[0].length);
  return dropEmptySections(b).trim();
}

/** Remove headings that have no content before the next heading or EOF. */
function dropEmptySections(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j >= lines.length || /^#{1,6}\s/.test(lines[j])) continue;
    }
    out.push(lines[i]);
  }
  return out.join("\n");
}

// ── Public: helpers for graduating a rolled-up feature ────────────────

/** True when the body opts into rollup (has a children zone). */
export function hasRollupZone(body: string): boolean {
  return body.includes(CHILDREN_OPEN);
}

/** Remove every rollup marker comment line; keeps the content between them. */
export function stripRollupMarkers(body: string): string {
  return body
    .split("\n")
    .filter((l) => !/^\s*<!--\s*\/?rollup:[^>]*-->\s*$/.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * One-line summary from the totals block, e.g.
 * "Entries 4 · Tasks 74 · Files 63 · Duration 6:32". Null when the
 * body has no populated totals block.
 */
export function totalsSummary(body: string): string | null {
  const zone = findTotalsZone(body);
  if (!zone) return null;
  const parts = body
    .slice(zone.innerStart, zone.innerEnd)
    .split("\n")
    .map((l) => l.match(/^-\s*([^:]+):\s*\*{0,2}([^*]+?)\*{0,2}\s*$/))
    .filter((m): m is RegExpMatchArray => !!m && m[2].trim() !== "—")
    .map((m) => `${m[1].trim()} ${m[2].trim()}`);
  return parts.length ? parts.join(" · ") : null;
}

// ── Public: upsert a child block in the parent's rollup zone ─────────────

export interface ChildMeta {
  taskId: string;
  title: string;
  /** ISO date (YYYY-MM-DD). Used for ordering + the header date. */
  when: string;
  /** Render the block as the single line "<title>, shipped <when>" (no distilled text). */
  oneLine?: boolean;
}

/**
 * Insert or replace a child's rolled-up block inside the parent's
 * `<!-- rollup:children -->…<!-- /rollup:children -->` zone. Blocks are keyed
 * by taskId (anchor comment) and ordered by `when` ascending.
 *
 * Returns the mutated parent body. If the parent body has no children zone,
 * returns it unchanged (opt-in via marker presence).
 */
export function upsertRollupBlock(
  parentBody: string,
  child: ChildMeta,
  distilled: string
): string {
  const zone = findZone(parentBody, CHILDREN_OPEN, CHILDREN_CLOSE);
  if (!zone) return parentBody;

  const inner = parentBody.slice(zone.innerStart, zone.innerEnd);
  const blocks = splitBlocks(inner);

  const newBlock: Block = {
    taskId: child.taskId,
    when: child.when,
    content: renderBlock(child, distilled),
  };

  const existing = blocks.findIndex((b) => b.taskId === child.taskId);
  if (existing >= 0) {
    blocks[existing] = newBlock;
  } else {
    blocks.push(newBlock);
  }
  blocks.sort((a, b) => a.when.localeCompare(b.when));

  const rendered =
    "\n" + blocks.map((b) => b.content).join("\n\n").trim() + "\n";
  return (
    parentBody.slice(0, zone.innerStart) +
    rendered +
    parentBody.slice(zone.innerEnd)
  );
}

interface Block {
  taskId: string;
  when: string;
  content: string;
}

function renderBlock(child: ChildMeta, distilled: string): string {
  if (child.oneLine) {
    return [
      `<!-- rollup:item id=${child.taskId} when=${child.when} -->`,
      `- ${child.title}, shipped ${child.when}`,
      ITEM_CLOSE,
    ].join("\n");
  }
  return [
    `<!-- rollup:item id=${child.taskId} when=${child.when} -->`,
    `### ${formatDate(child.when)} — ${child.title}`,
    "",
    distilled,
    ITEM_CLOSE,
  ].join("\n");
}

/** `2026-10-18` → `Sun 10/18`. ISO dates are UTC-free; parse as calendar day. */
function formatDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  const [, y, mo, d] = m;
  // Date in local tz for weekday rendering. UTC noon avoids tz-rollover.
  const date = new Date(`${y}-${mo}-${d}T12:00:00Z`);
  const dow = date.toLocaleDateString("en-US", {
    weekday: "short",
    timeZone: "UTC",
  });
  return `${dow} ${Number(mo)}/${Number(d)}`;
}

function splitBlocks(zoneInner: string): Block[] {
  const out: Block[] = [];
  ITEM_OPEN_RE.lastIndex = 0;
  const anchors: { taskId: string; when: string; start: number; headerEnd: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = ITEM_OPEN_RE.exec(zoneInner))) {
    anchors.push({
      taskId: m[1],
      when: m[2],
      start: m.index,
      headerEnd: m.index + m[0].length,
    });
  }
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    const end = i + 1 < anchors.length ? anchors[i + 1].start : zoneInner.length;
    out.push({
      taskId: a.taskId,
      when: a.when,
      content: zoneInner.slice(a.start, end).replace(/\s+$/, ""),
    });
  }
  return out;
}

// ── Public: recompute the totals block ───────────────────────────────────

/**
 * Scan the children zone for `Key: value [unit]` fragments across declared
 * keys, sum them, and render the `<!-- rollup:totals -->` block. If no
 * totals zone exists, returns the parent body unchanged.
 */
export function recomputeTotals(parentBody: string): string {
  const totals = findTotalsZone(parentBody);
  if (!totals) return parentBody;

  const childrenZone = findZone(parentBody, CHILDREN_OPEN, CHILDREN_CLOSE);
  const childrenInner = childrenZone
    ? parentBody.slice(childrenZone.innerStart, childrenZone.innerEnd)
    : "";

  const sums = sumKeys(childrenInner, totals.keys);
  const lines = [
    "",
    `- Sessions: **${countBlocks(childrenInner)}**`,
    ...totals.keys.map((k) => `- ${k}: **${renderTotal(k, sums[k])}**`),
    "",
  ];
  const rendered = lines.join("\n");
  return (
    parentBody.slice(0, totals.innerStart) +
    rendered +
    parentBody.slice(totals.innerEnd)
  );
}

function countBlocks(zoneInner: string): number {
  const re = /<!--\s*rollup:item\s+id=/g;
  return (zoneInner.match(re) || []).length;
}

interface TotalsZone {
  innerStart: number;
  innerEnd: number;
  keys: string[];
}

function findTotalsZone(body: string): TotalsZone | null {
  const openMatch = body.match(TOTALS_OPEN_RE);
  if (!openMatch) return null;
  const openStart = (openMatch.index ?? -1);
  if (openStart < 0) return null;
  const headerEnd = openStart + openMatch[0].length;
  const closeIdx = body.indexOf(TOTALS_CLOSE, headerEnd);
  if (closeIdx < 0) return null;
  return {
    innerStart: headerEnd,
    innerEnd: closeIdx,
    keys: openMatch[1].split(",").map((k) => k.trim()).filter(Boolean),
  };
}

// ── Public: value parsing ────────────────────────────────────────────────

export interface ParsedValue {
  n: number;
  unit: string;
  /** True when the value was in H:MM shape (minutes with time semantics). */
  isTime: boolean;
}

/**
 * Parse the first `Key: value [unit]` fragment that matches `key` on any line
 * of `block`. Case-insensitive on the key. Returns null when no match.
 */
export function parseKeyedValue(block: string, key: string): ParsedValue | null {
  // Case-insensitive, word-boundary key. Value runs until whitespace, pipe,
  // or end-of-string. Non-greedy to let the trailing bold-marker (``**``)
  // match outside the capture.
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `\\b${esc}\\s*:\\s*\\*{0,2}([^|\\n]+?)\\*{0,2}(?=\\||\\n|$)`,
    "i"
  );
  const m = block.match(re);
  if (!m) return null;
  return parseValue(m[1].trim());
}

function parseValue(raw: string): ParsedValue | null {
  const t = raw.replace(/,/g, "").trim();
  if (!t) return null;
  // H:MM
  const time = t.match(/^(\d+):(\d{2})$/);
  if (time) {
    return { n: Number(time[1]) * 60 + Number(time[2]), unit: "min", isTime: true };
  }
  // approx time "~1:40"
  const approxTime = t.match(/^~?(\d+):(\d{2})$/);
  if (approxTime) {
    return { n: Number(approxTime[1]) * 60 + Number(approxTime[2]), unit: "min", isTime: true };
  }
  // number [unit]
  const nu = t.match(/^(-?\d+(?:\.\d+)?)\s*([a-zA-Z%]+)?$/);
  if (nu) {
    return { n: Number(nu[1]), unit: (nu[2] ?? "").toLowerCase(), isTime: false };
  }
  return null;
}

// ── Totals summation ─────────────────────────────────────────────────────

export function sumKeys(zoneInner: string, keys: string[]): Record<string, ParsedValue> {
  const out: Record<string, ParsedValue> = {};
  const blocks = splitBlocks(zoneInner);
  for (const k of keys) {
    let sum = 0;
    let unit = "";
    let isTime = false;
    for (const b of blocks) {
      const v = parseKeyedValue(b.content, k);
      if (!v) continue;
      sum += v.n;
      if (!unit && v.unit) unit = v.unit;
      if (v.isTime) isTime = true;
    }
    out[k] = { n: sum, unit, isTime };
  }
  return out;
}

function renderTotal(key: string, v: ParsedValue | undefined): string {
  if (!v || v.n === 0) return "—";
  // Duration / time keys → H:MM
  if (v.isTime || /duration|time/i.test(key)) {
    const h = Math.floor(v.n / 60);
    const m = Math.round(v.n % 60);
    return `${h}:${m.toString().padStart(2, "0")}`;
  }
  const num = v.n.toLocaleString();
  return v.unit ? `${num} ${v.unit}` : num;
}

// ── Zone finder ──────────────────────────────────────────────────────────

interface Zone {
  innerStart: number;
  innerEnd: number;
}

function findZone(body: string, open: string, close: string): Zone | null {
  const openIdx = body.indexOf(open);
  if (openIdx < 0) return null;
  const headerEnd = openIdx + open.length;
  const closeIdx = body.indexOf(close, headerEnd);
  if (closeIdx < 0) return null;
  return { innerStart: headerEnd, innerEnd: closeIdx };
}

// ── Outcomes section ─────────────────────────────────────────────────────

const CHILDREN_ZONE = `${CHILDREN_OPEN}\n${CHILDREN_CLOSE}`;

/**
 * The body with a children zone in place, and whether that zone is a LEGACY
 * one (outside an `## Outcomes` section). A missing zone is created: inside an
 * existing `## Outcomes` section, else in a new section at the end. Everything
 * outside the Outcomes section is preserved byte for byte.
 */
export function ensureOutcomesZone(body: string): { body: string; legacy: boolean } {
  const span = findSection(body, OUTCOMES_HEADING);
  const zone = findZone(body, CHILDREN_OPEN, CHILDREN_CLOSE);
  if (zone) {
    return { body, legacy: !(span && zone.innerStart >= span.start && zone.innerEnd <= span.end) };
  }
  if (span) {
    const rest = body.slice(span.end);
    const next =
      body.slice(0, span.start) + body.slice(span.start, span.end).trimEnd() + `\n\n${CHILDREN_ZONE}` + (rest ? `\n\n${rest}` : "\n");
    return { body: next, legacy: false };
  }
  const gap = body.endsWith("\n\n") ? "" : body.endsWith("\n") ? "\n" : body ? "\n\n" : "";
  return { body: `${body}${gap}${OUTCOMES_HEADING}\n\n${CHILDREN_ZONE}\n`, legacy: false };
}

/** The outcomes written so far: the children zone's text without markers; "" when none. */
export function outcomesText(body: string): string {
  const zone = findZone(body, CHILDREN_OPEN, CHILDREN_CLOSE);
  return zone ? stripRollupMarkers(body.slice(zone.innerStart, zone.innerEnd)).trim() : "";
}

/** The Totals block of a document (its lines, no markers); "" when it has none or all values are empty. */
export function totalsText(body: string): string {
  const t = findTotalsZone(body);
  if (!t) return "";
  const lines = body.slice(t.innerStart, t.innerEnd).split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- "));
  return totalsValues(body).length ? lines.join("\n") : "";
}

/** Every populated Totals value as {key, value}, e.g. {key: "Volume", value: "21,300 lb"}. */
export function totalsValues(body: string): Array<{ key: string; value: string }> {
  const zone = findTotalsZone(body);
  if (!zone) return [];
  return body
    .slice(zone.innerStart, zone.innerEnd)
    .split("\n")
    .map((l) => l.match(/^-\s*([^:]+):\s*\*{0,2}([^*]+?)\*{0,2}\s*$/))
    .filter((m): m is RegExpMatchArray => !!m && m[2].trim() !== "—" && m[2].trim() !== "0")
    .map((m) => ({ key: m[1].trim(), value: m[2].trim() }));
}

/**
 * The document without its rollup machinery: no `## Outcomes` section, no
 * children zone (a legacy one keeps its section heading only if it has other
 * content), no totals block, no markers. What the PLAN says.
 */
export function withoutRollup(body: string): string {
  let out = body;
  const span = findSection(out, OUTCOMES_HEADING);
  if (span) out = out.slice(0, span.start) + out.slice(span.end);
  for (const [open, close] of [[CHILDREN_OPEN, CHILDREN_CLOSE]] as const) {
    const z = findZone(out, open, close);
    if (z) out = out.slice(0, z.innerStart - open.length) + out.slice(z.innerEnd + close.length);
  }
  const t = findTotalsZone(out);
  if (t) {
    const start = out.search(TOTALS_OPEN_RE);
    out = out.slice(0, start) + out.slice(t.innerEnd + TOTALS_CLOSE.length);
  }
  return dropEmptySections(out).replace(/\n{3,}/g, "\n\n").trim();
}

// ── Orchestrator (I/O boundary) ──────────────────────────────────────────

export interface RollupClient {
  query(q: { ids?: string[] }): Promise<Array<{
    id: string;
    kind: string;
    title: string;
    partOf: string | null;
    updated: string;
    successCriteria?: string | null;
    /** Holding container (the Inbox): no Outcomes. */
    container?: boolean;
  }>>;
  getBody(id: string): Promise<string>;
  updateBody(id: string, body: string): Promise<void>;
}

/**
 * Fold a shipped task into its parent feature's Outcomes. No-op when:
 *   - the task has no parent;
 *   - the parent is not a feature, or is the Inbox container.
 *
 * Totals are recomputed when the feature declares a `<!-- rollup:totals -->`
 * block. Errors reject — callers log but should NOT block the ship on a
 * rollup failure.
 */
export async function rollupToParent(
  client: RollupClient,
  taskId: string
): Promise<"written" | "no-parent" | "no-content"> {
  const items = await client.query({ ids: [taskId] });
  const task = items[0];
  if (!task) return "no-parent";
  if (!task.partOf) return "no-parent";

  const parents = await client.query({ ids: [task.partOf] });
  const parent = parents[0];
  if (!parent || parent.kind !== "feature" || parent.container) return "no-parent";

  const original = await client.getBody(parent.id);
  const { body: parentBody, legacy } = ensureOutcomesZone(original);

  const taskBody = await client.getBody(task.id);
  const when = (task.updated || "").slice(0, 10) || new Date().toISOString().slice(0, 10);
  let distilled: string;
  let oneLine = false;
  if (legacy) {
    // A task nobody wrote a body for still records what it delivered.
    distilled =
      extractDistilled(taskBody) ||
      (task.successCriteria ? `Delivered: ${task.successCriteria}` : "");
    if (!distilled) return "no-content";
  } else {
    distilled = extractRollupSection(taskBody);
    oneLine = !distilled;
  }

  let next = upsertRollupBlock(parentBody, { taskId: task.id, title: task.title, when, oneLine }, distilled);
  next = recomputeTotals(next);

  if (next !== original) {
    await client.updateBody(parent.id, next);
  }
  return "written";
}

/** The task's own `## Rollup` section, or "" when it has none. */
function extractRollupSection(body: string): string {
  const h = /(?:^|\n)##\s+Rollup[^\n]*\n/.exec(body ?? "");
  return h ? extractDistilled(body) : "";
}
