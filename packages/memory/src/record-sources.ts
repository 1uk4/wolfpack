/**
 * Where a Record line came from: the ids and timestamps of the observations behind it.
 *
 * Stored as a trailing HTML comment on the bullet, so the rendered Record reads as before (a markdown view hides
 * it) and the line is still one line of plain text a human or a script can follow:
 *
 *   - Use a TTL cache — why: invalidation is hard <!-- src: 1a2b3c4d5e6f7a8b@2026-10-27T10:00:00.000Z c3d4…@… -->
 *   - Another line <!-- src[batch]: … -->
 *
 * `src:` the model mapped the line to its observations (per line). `src[batch]:` it did not, so the line carries
 * the ids of the whole batch it was written from (per batch: a superset). A line without a comment is an older
 * line: it parses and renders, it just has no sources. A line carried over unchanged keeps its sources.
 *
 * A sidecar keyed by line hash was rejected: it can drift from the document the Work API owns, and the document
 * is the only thing that travels with the item (archive, graduation). Prompts and agent views strip the comments.
 */
import { createHash } from "node:crypto";

export interface SourceRef {
  id: string;
  timestamp?: string;
}

/** Most refs one line keeps (the newest); older ones are in the archive under the same ids. */
export const SOURCE_CAP = 24;

const COMMENT = /[ \t]*<!-- src(\[batch\])?: ([^>]*?) -->[ \t]*$/;

const clean = (s: string) => s.replace(/\s+/g, "_").replace(/--+/g, "-").replace(/[<>]/g, "");

export function formatSources(refs: SourceRef[], batch: boolean): string {
  if (refs.length === 0) return "";
  const kept = refs.slice(-SOURCE_CAP);
  return ` <!-- src${batch ? "[batch]" : ""}: ${kept.map((r) => (r.timestamp ? `${clean(r.id)}@${clean(r.timestamp)}` : clean(r.id))).join(" ")} -->`;
}

/** The text without source comments (what the agent and the model see). */
export function stripSources(text: string): string {
  return text.split("\n").map((l) => l.replace(COMMENT, "")).join("\n");
}

/** Stable reference to a Record line: its group and text (not its position). */
export const lineRef = (group: string, text: string): string =>
  createHash("sha1").update(`${group}\u0000${text.replace(/\s+/g, " ").trim()}`).digest("hex").slice(0, 8);

export interface RecordLine {
  /** `Decisions`, `Changes`, `Findings`, `Problems & fixes` (the `###` heading). */
  group: string;
  /** The visible text, without the source comment. */
  text: string;
  ref: string;
  sources: SourceRef[];
  /** The sources are the batch's, not the line's own (see the header). */
  batch: boolean;
}

function parseRefs(s: string): SourceRef[] {
  return s.split(/\s+/).filter(Boolean).map((p) => {
    const at = p.indexOf("@");
    return at < 0 ? { id: p } : { id: p.slice(0, at), timestamp: p.slice(at + 1) };
  });
}

/** The bullets of a Record section (`## Record` text), in order. Never throws: a Record of any age parses. */
export function parseRecordLines(record: string): RecordLine[] {
  const out: RecordLine[] = [];
  let group = "";
  for (const line of record.split("\n")) {
    const h = /^### (.+?)\s*$/.exec(line);
    if (h) { group = h[1]; continue; }
    if (!line.startsWith("- ")) continue;
    const m = COMMENT.exec(line);
    const text = (m ? line.slice(0, m.index) : line).slice(2).trim();
    out.push({ group, text, ref: lineRef(group, text), sources: m ? parseRefs(m[2]) : [], batch: !!m?.[1] });
  }
  return out;
}

/** The Record for the model: comments stripped, every bullet prefixed `[rN]` (N from 1, the order of parseRecordLines). */
export function numberRecordLines(record: string): string {
  let n = 0;
  return stripSources(record).split("\n").map((l) => (l.startsWith("- ") ? `- [r${++n}] ${l.slice(2)}` : l)).join("\n");
}
