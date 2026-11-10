/**
 * Compaction of a capped Record. When a hub append answers `log_full`, `compactRecord` rewrites the item's `## Record`
 * section shorter (target: at most half the cap) so appends can go on.
 *
 * 1. Read the Record's lines (`- HH:MM [src·kind] text <!-- src:ids -->`; a feature keeps its `###` groups).
 * 2. One `workCompact` model call (fast tier) returns fewer lines, each citing the input lines it merges (`from: ["l3","l7"]`).
 * 3. Ids: a new line carries the union of the ids of the lines it merges, so the hub's dedupe history survives.
 *    A `distilled:<taskId>` id on a line no output line cited is NOT dropped: it moves onto the first output line of
 *    the same group, or, when the group has no output line, onto a marker-only line `earlier lines compacted`. Without
 *    these markers a shipped task would be distilled again.
 * 4. Write: `setRecord` replaces the whole section. It is a read-modify-write: the Record is re-read right before the
 *    write and, if it differs from the first read, nothing is written (`{ok:false, reason:"changed"}`). Nothing is held
 *    during the model call.
 * 5. Fallback (model failed, answered nothing usable, or the result is not within half the cap): a deterministic trim.
 *    Lines are dropped oldest first, lines without a `distilled:` id before lines with one, until the Record is at
 *    most 60% of the cap. Every `distilled:` id of a dropped line moves onto ONE line, `- earlier lines compacted`
 *    (group Changes on a feature), so the once-only markers survive. Other ids of dropped lines are lost.
 *
 * Never throws.
 */
import { z } from "zod";
import { WORK_COMPACT_SYSTEM, buildWorkCompactPrompt, parseWorkCompactOutput, type Engine } from "@wolfpack/engine";
import { APPEND_CAP_FEATURE, APPEND_CAP_TASK, RECORD_HEADING, extractRecord, type AppendRecordResult, type RecordAppendLine, type WorkRecordStore } from "../work-record.js";
import { noComments } from "../record-sources.js";

export type CompactResult = { ok: true; before: number; after: number; mode: "model" | "trim" } | { ok: false; reason: string };

export const recordCap = (kind: string): number => (kind === "feature" ? APPEND_CAP_FEATURE : APPEND_CAP_TASK);

const COMPACTED = "earlier lines compacted";
const GROUP_KIND: Record<string, string> = { Decisions: "decision", Changes: "change", Findings: "finding", "Problems & fixes": "problem" };

interface Line {
  group: string;
  time: string;
  src: string;
  /** The label after the `·`: `change` on a task, the group word on a feature. */
  kind: string;
  text: string;
  ids: string[];
}

const LINE = /^- (\d\d:\d\d) \[([^\]·]*)·([^\]]*)\] (.*)$/;
const COMMENT = /\s*<!-- src:([^>]*?) -->\s*$/;
const isMarker = (id: string) => id.startsWith("distilled:");
const uniq = (xs: string[]) => [...new Set(xs)];

function parse(record: string): Line[] {
  const out: Line[] = [];
  let group = "";
  for (const raw of record.split("\n")) {
    const h = /^### (.+?)\s*$/.exec(raw);
    if (h) { group = h[1]!; continue; }
    if (!raw.startsWith("- ")) continue;
    const c = COMMENT.exec(raw);
    const ids = c ? c[1]!.split(/[,\s]+/).filter(Boolean) : [];
    const body = c ? raw.slice(0, c.index) : raw;
    const m = LINE.exec(body);
    out.push(m ? { group, time: m[1]!, src: m[2]!, kind: m[3]!, text: m[4]!.trim(), ids } : { group, time: "00:00", src: "", kind: GROUP_KIND[group] ?? "change", text: body.slice(2).trim(), ids });
  }
  return out;
}

const render = (lines: Line[]): string => {
  const row = (l: Line) => `- ${l.time} [${l.src}\u00b7${l.kind}] ${l.text}${l.ids.length ? ` <!-- src:${l.ids.join(",")} -->` : ""}`;
  if (!lines.some((l) => l.group)) return [RECORD_HEADING, "", ...lines.map(row)].join("\n");
  const groups = uniq(lines.map((l) => l.group));
  const parts = groups.map((g) => [`### ${g}`, "", ...lines.filter((l) => l.group === g).map(row)].join("\n"));
  return [RECORD_HEADING, "", parts.join("\n\n")].join("\n");
};

const modelKind = (l: Line): string => GROUP_KIND[l.kind] ?? (["decision", "change", "finding", "problem"].includes(l.kind) ? l.kind : GROUP_KIND[l.group] ?? "change");

/** The model's answer applied to the input lines; null when it is unusable. */
function applyModel(lines: Line[], answer: unknown): Line[] | null {
  const parsed = parseWorkCompactOutput(JSON.stringify(answer));
  const out: Array<Line & { cited: Line[] }> = [];
  for (const p of parsed) {
    const cited = uniq(p.from).flatMap((f) => { const l = lines[Number(f.slice(1)) - 1]; return l ? [l] : []; });
    if (!cited.length) continue;
    const first = cited[0]!;
    out.push({ group: first.group, time: first.time, src: first.src, kind: p.kind, text: noComments(p.text), ids: uniq(cited.flatMap((l) => l.ids)), cited });
  }
  if (!out.length) return null;
  const citedSet = new Set(out.flatMap((o) => o.cited));
  const result: Line[] = out.map(({ cited: _c, ...l }) => l);
  // Markers of uncited lines move onto the first output line of their group, or a marker-only line.
  for (const l of lines) {
    if (citedSet.has(l)) continue;
    const markers = l.ids.filter(isMarker);
    if (!markers.length) continue;
    const host = result.find((r) => r.group === l.group);
    if (host) host.ids = uniq([...host.ids, ...markers]);
    else result.push({ group: l.group, time: l.time, src: l.src, kind: "change", text: COMPACTED, ids: markers });
  }
  return result;
}

/** Deterministic trim to at most 60% of `cap` (see the header). */
function trim(lines: Line[], cap: number): Line[] {
  const limit = Math.floor(cap * 0.6);
  const feature = lines.some((l) => l.group);
  const order = [...lines.map((l, i) => ({ l, i })).filter((x) => !x.l.ids.some(isMarker)), ...lines.map((l, i) => ({ l, i })).filter((x) => x.l.ids.some(isMarker))];
  const dropped = new Set<Line>();
  const build = (): Line[] => {
    const kept = lines.filter((l) => !dropped.has(l));
    const markers = uniq([...dropped].flatMap((l) => l.ids.filter(isMarker)));
    if (!markers.length) return kept;
    const g = feature ? "Changes" : "";
    const at = kept.findIndex((l) => l.group === g);
    const mark: Line = { group: g, time: "00:00", src: "", kind: "change", text: COMPACTED, ids: markers };
    const first = [...dropped][0]!;
    mark.time = first.time;
    mark.src = first.src;
    return at < 0 ? [...kept, mark] : [...kept.slice(0, at), mark, ...kept.slice(at)];
  };
  for (const { l } of order) {
    if (render(build()).length <= limit) break;
    dropped.add(l);
  }
  return build();
}

export async function compactRecord(opts: {
  store: WorkRecordStore;
  engine: Pick<Engine, "call">;
  id: string;
  cap: number;
  src: string;
}): Promise<CompactResult> {
  const { store, engine, id, cap } = opts;
  try {
    const item = await store.get(id);
    if (!item) return { ok: false, reason: "not found" };
    if (item.stage === "archived") return { ok: false, reason: "archived" };
    const before = extractRecord(item.body);
    if (!before) return { ok: false, reason: "empty" };
    const lines = parse(before);
    if (!lines.length) return { ok: false, reason: "empty" };

    const target = Math.floor(cap * 0.5);
    let next: Line[] | null = null;
    try {
      const raw = await engine.call("workCompact", z.object({ lines: z.array(z.unknown()) }).passthrough(), {
        system: WORK_COMPACT_SYSTEM,
        prompt: buildWorkCompactPrompt({ lines: lines.map((l) => ({ kind: modelKind(l), text: l.text })), targetChars: target }),
      });
      next = applyModel(lines, raw);
    } catch {
      next = null;
    }
    let mode: "model" | "trim" = "model";
    if (!next || render(next).length > target) {
      next = trim(lines, cap);
      mode = "trim";
    }
    const rendered = render(next).trimEnd();

    const again = await store.get(id);
    if (!again || extractRecord(again.body) !== before) return { ok: false, reason: "changed" };
    // Known window: no hub compare-and-set, so a recordAppend landing between the re-read above and this write is overwritten.
    await store.setRecord(id, rendered);
    return { ok: true, before: before.length, after: rendered.length, mode };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Append; on `log_full` compact once and retry once. Still full (or compaction failed): the original result. */
export async function appendCompacting(opts: {
  store: WorkRecordStore;
  engine: Pick<Engine, "call">;
  id: string;
  kind: string;
  src: string;
  lines: RecordAppendLine[];
  group?: string;
}): Promise<AppendRecordResult> {
  const { store, id, lines } = opts;
  const o = opts.group ? { group: opts.group } : undefined;
  const first = await store.appendRecord(id, lines, o);
  if (first.ok || first.code !== "log_full") return first;
  const c = await compactRecord({ store, engine: opts.engine, id, cap: recordCap(opts.kind), src: opts.src });
  if (!c.ok) return first;
  return store.appendRecord(id, lines, o);
}
