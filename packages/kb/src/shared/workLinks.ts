/**
 * Work links — the note format that records which KB entries a graduated work
 * item created or updated. Pure: shared by Dewey (writes the notes, see
 * librarian/work-links.ts) and the wolves (read them back).
 *
 *     KB: created kb-wolfpack-X
 *     KB: updated kb-wolfpack-Y
 */

export interface WorkLink {
  workId: string;
  entryId: string;
  action: "created" | "updated";
}

/** The work item a den topic id belongs to: `work-<domain>-<id>` or `…~<slug>`. */
export function workIdOfTopic(denTopicId: string): string | null {
  return /^(work-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9A-Za-z]{7})(?:~.+)?$/.exec(denTopicId)?.[1] ?? null;
}

/** The note text for one link. */
export const linkNote = (l: Pick<WorkLink, "action" | "entryId">): string => `KB: ${l.action} ${l.entryId}`;

/** Every `KB:` note of a work item's log, as the entries it created and updated (in order, unique). */
export function parseKbNotes(log: Array<{ text: string }> | undefined): { created: string[]; updated: string[]; all: string[] } {
  const created: string[] = [];
  const updated: string[] = [];
  for (const { text } of log ?? []) {
    if (!/^KB:/.test(text)) continue;
    for (const m of text.matchAll(/\b(created|updated) (kb-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9A-Za-z]{7})\b/g)) {
      const into = m[1] === "created" ? created : updated;
      if (!into.includes(m[2])) into.push(m[2]);
    }
  }
  const all = [...new Set([...created, ...updated])];
  return { created, updated, all };
}

// ── Delivered: an initiative entry's list of its features and the entries they updated ──

/** One `## Delivered` bullet: a feature title and the entries it created or updated. */
export interface DeliveredBullet {
  title: string;
  links: string[];
}

const DELIVERED_HEADING = /^## Delivered[ \t]*$/m;
const ENTRY_LINK = /\[\[(kb-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9A-Za-z]{7})(?:\|[^\]]*)?\]\]/g;
const normTitle = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();

/** `- <title>: [[kb-…]], [[kb-…]]` (just `- <title>` when it has no entries yet). */
export function renderDelivered(b: DeliveredBullet): string {
  const links = [...new Set(b.links)];
  return `- ${b.title.replace(/\s+/g, " ").trim()}${links.length ? `: ${links.map((l) => `[[${l}]]`).join(", ")}` : ""}`;
}

/** The title of a `## Delivered` line: the text before its first link, minus the trailing colon. */
function bulletTitle(line: string): string {
  const text = line.replace(/^-\s+/, "");
  const at = text.search(/\[\[/);
  return (at < 0 ? text : text.slice(0, at)).replace(/[:\s—–-]+$/, "").trim();
}

function deliveredRange(body: string): { start: number; end: number } | null {
  const m = DELIVERED_HEADING.exec(body);
  if (!m) return null;
  const after = m.index + m[0].length;
  const next = body.slice(after).search(/^## /m);
  return { start: m.index, end: next < 0 ? body.length : after + next };
}

/** The bullets of an entry body's `## Delivered` section. */
export function deliveredBullets(body: string): DeliveredBullet[] {
  const r = deliveredRange(body);
  if (!r) return [];
  return body
    .slice(r.start, r.end)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => ({ title: bulletTitle(l), links: [...l.matchAll(ENTRY_LINK)].map((m) => m[1]) }));
}

/**
 * Drop model-written prose that stands in for the list: a heading such as
 * `## Delivered by the sweep work` (with its section) or a paragraph that opens
 * "Delivered by …". The exact `## Delivered` list is left alone.
 */
export function stripProseDelivered(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const h = /^(#{2,4}) Delivered\b(?!\s*$)/.exec(lines[i]);
    if (h) {
      // skip to the next heading of the same or a higher level
      i++;
      while (i < lines.length && !new RegExp(`^#{1,${h[1].length}} `).test(lines[i])) i++;
      i--;
      continue;
    }
    if (/^(?:\*\*|_)?Delivered by\b/i.test(lines[i])) {
      while (i + 1 < lines.length && lines[i + 1].trim() !== "") i++;
      continue;
    }
    out.push(lines[i]);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Merge `bullets` into the body's `## Delivered` section without duplicating it:
 * a bullet whose feature is listed already adds only the links it lacks; a new
 * feature is appended. A body without the section gets one before `## History`
 * (or at the end). The model's own lines and wording stand.
 */
export function mergeDelivered(body: string, bullets: DeliveredBullet[]): string {
  const want = bullets.filter((b) => b.title.trim());
  if (want.length === 0) return body;
  body = stripProseDelivered(body);
  const r = deliveredRange(body);
  const lines = r
    ? body.slice(r.start, r.end).trimEnd().split("\n")
    : ["## Delivered", ""];
  const idx = (t: string) => lines.findIndex((l) => l.trim().startsWith("- ") && normTitle(bulletTitle(l.trim())) === normTitle(t));
  for (const b of want) {
    const at = idx(b.title);
    if (at < 0) {
      lines.push(renderDelivered(b));
      continue;
    }
    const have = new Set([...lines[at].matchAll(ENTRY_LINK)].map((m) => m[1]));
    const missing = [...new Set(b.links)].filter((l) => !have.has(l));
    if (missing.length) {
      lines[at] = `${lines[at].trimEnd()}${have.size ? "," : ":"} ${missing.map((l) => `[[${l}]]`).join(", ")}`;
    }
  }
  const section = lines.join("\n").trimEnd();
  if (r) return `${body.slice(0, r.start)}${section}\n${body.slice(r.end) ? `\n${body.slice(r.end).replace(/^\n+/, "")}` : ""}`;
  const h = body.search(/^## History[ \t]*$/m);
  if (h < 0) return `${body.trimEnd()}\n\n${section}\n`;
  return `${body.slice(0, h).trimEnd()}\n\n${section}\n\n${body.slice(h)}`;
}

/**
 * Rewrite the entry links of every `## Delivered` bullet through `map` (a list
 * in, a list out: retired ids to their survivors, unresolvable ones dropped,
 * duplicates collapsed). Titles and all other lines are left as they are.
 */
export function mapDeliveredLinks(body: string, map: (links: string[]) => string[]): string {
  const r = deliveredRange(body);
  if (!r) return body;
  const section = body
    .slice(r.start, r.end)
    .split("\n")
    .map((l) => {
      if (!l.trim().startsWith("- ")) return l;
      const links = [...l.matchAll(ENTRY_LINK)].map((m) => m[1]);
      if (!links.length) return l;
      const next = [...new Set(map(links))];
      return next.length === links.length && next.every((x, i) => x === links[i]) ? l : renderDelivered({ title: bulletTitle(l.trim()), links: next });
    })
    .join("\n");
  return `${body.slice(0, r.start)}${section}${body.slice(r.end)}`;
}
