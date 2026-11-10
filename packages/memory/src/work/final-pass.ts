/**
 * Final feature pass: when a feature ships or graduates, one model call (workTidy) tidies its Record, exactly once.
 *
 * Once-only marker: the id `final-pass:<featureId>` sits in the `<!-- src:… -->` ids of one Record line. A feature
 * that carries it is skipped before any model call. Each new line's ids are the union of the ids of the input
 * lines it cites (so `distilled:*` markers survive); a `distilled:` id nobody cited goes onto the first kept line
 * of its group, as in compaction.
 *
 * The Record is re-read before writing; if it changed meanwhile nothing is written (`{ok:false, reason:"changed"}`).
 * When the model fails, returns nothing usable, or the answer is not shorter, only a marker line is appended so
 * the pass is not retried. Never throws.
 */
import { z } from "zod";
import { WORK_TIDY_SYSTEM, buildWorkTidyPrompt, parseWorkTidyOutput, type Engine } from "@wolfpack/engine";
import { extractRecord, RECORD_HEADING, APPEND_CAP_FEATURE, type WorkRecordStore } from "../work-record.js";
import { outcomesText } from "./rollup.js";
import { sweepPendingDistills, type SweepClient } from "./ship-distill.js";

export type FinalPassResult =
  | { ok: true; status: "tidied" | "marker-only" | "already" | "skipped"; before: number; after: number }
  | { ok: false; reason: string };

export const finalPassId = (featureId: string): string => `final-pass:${featureId}`;

const GROUPS = ["Decisions", "Changes", "Findings", "Problems & fixes"];
/** The label after `·` is always a protocol kind; the `###` heading keeps the group. */
const GROUP_KIND: Record<string, string> = { Decisions: "decision", Changes: "change", Findings: "finding", "Problems & fixes": "problem" };

interface Parsed { group: string; text: string; ids: string[] }

function parseRecord(body: string): Parsed[] {
  const rec = (extractRecord(body) ?? "").slice(RECORD_HEADING.length);
  const out: Parsed[] = [];
  let group = "Changes";
  for (const raw of rec.split("\n")) {
    const l = raw.trim();
    if (l.startsWith("### ")) { group = l.slice(4).trim(); continue; }
    if (!l.startsWith("- ")) continue;
    const m = /<!--\s*src:([^>]*?)\s*-->/.exec(l);
    const ids = m ? m[1]!.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const text = l.slice(2).replace(/<!--.*?-->/g, "").replace(/^\d\d:\d\d\s+\[[^\]]*\]\s*/, "").trim();
    if (text || ids.length) out.push({ group, text, ids });
  }
  return out;
}

export async function finalFeaturePass(opts: {
  store: WorkRecordStore;
  engine: Pick<Engine, "call">;
  featureId: string;
  /** Plain label for the lines' source (the acting wolf). */
  src: string;
  now?: () => Date;
}): Promise<FinalPassResult> {
  const { store, engine, featureId } = opts;
  try {
    const feature = await store.get(featureId);
    if (!feature || feature.kind !== "feature" || feature.container) return { ok: true, status: "skipped", before: 0, after: 0 };
    const snapshot = feature.body; // stores may hand back the live object
    const input = parseRecord(snapshot);
    if (!input.length) return { ok: true, status: "skipped", before: 0, after: 0 };
    const marker = finalPassId(featureId);
    if (input.some((l) => l.ids.includes(marker))) return { ok: true, status: "already", before: 0, after: 0 };

    const at = (opts.now?.() ?? new Date()).toISOString();
    const hhmm = /T(\d\d:\d\d)/.exec(at)?.[1] ?? "00:00";
    const markerOnly = async (before: number): Promise<FinalPassResult> => {
      const r = await store.appendRecord(featureId, [{ at, src: opts.src, kind: "change", text: "final pass: nothing to tidy", ids: [marker] }], { group: "Changes" });
      return r.ok ? { ok: true, status: "marker-only", before, after: before } : { ok: false, reason: `append failed: ${r.code}` };
    };

    const before = input.reduce((n, l) => n + l.text.length, 0);
    let tidy: ReturnType<typeof parseWorkTidyOutput> = [];
    try {
      const prompt = buildWorkTidyPrompt({
        title: feature.title,
        outcomes: outcomesText(feature.body).split("\n").map((l) => l.trim()).filter(Boolean),
        lines: input.map((l) => ({ group: l.group, text: l.text })),
      });
      const raw = await engine.call("workTidy", z.object({ lines: z.array(z.unknown()) }), { system: WORK_TIDY_SYSTEM, prompt });
      tidy = parseWorkTidyOutput(JSON.stringify(raw));
    } catch {
      tidy = [];
    }

    // Re-read: anything written while the model ran wins; write nothing.
    const again = await store.get(featureId);
    if (!again || again.body !== snapshot) return { ok: false, reason: "changed" };

    const after = tidy.reduce((n, l) => n + l.text.length, 0);
    if (!tidy.length || after >= before) return markerOnly(before);

    const lines = tidy.map((l) => {
      const ids: string[] = [];
      for (const f of l.from) {
        const m = /^l(\d+)$/i.exec(f.trim());
        const src = m ? input[Number(m[1]) - 1] : undefined;
        if (src) for (const id of src.ids) if (!ids.includes(id)) ids.push(id);
      }
      return { group: l.group as string, text: l.text, ids };
    });
    lines[0]!.ids.push(marker);
    // A `distilled:` id no kept line carries goes onto the first kept line of its group.
    const have = new Set(lines.flatMap((l) => l.ids));
    for (const l of input) {
      for (const id of l.ids) {
        if (!id.startsWith("distilled:") || have.has(id)) continue;
        const target = lines.find((x) => x.group === l.group);
        if (target) { target.ids.push(id); have.add(id); }
      }
    }
    const parts = GROUPS.map((g) => [g, lines.filter((l) => l.group === g)] as const)
      .filter(([, ls]) => ls.length)
      .map(([g, ls]) => `### ${g}\n\n${ls.map((l) => `- ${hhmm} [${opts.src}\u00b7${GROUP_KIND[g] ?? "change"}] ${l.text}${l.ids.length ? ` <!-- src:${l.ids.join(",")} -->` : ""}`).join("\n")}`);
    const record = [RECORD_HEADING, ...parts].join("\n\n");
    if (record.length > APPEND_CAP_FEATURE) return markerOnly(before);
    await store.setRecord(featureId, record);
    return { ok: true, status: "tidied", before, after };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** The hook both runtimes call: distil every shipped task of the feature that is still pending, then run the pass. Never throws. */
export async function runFinalPass(opts: { client: SweepClient; store: WorkRecordStore; engine: Pick<Engine, "call">; featureId: string; src: string }): Promise<FinalPassResult> {
  await sweepPendingDistills({ client: opts.client, store: opts.store, engine: opts.engine, featureId: opts.featureId, src: opts.src, limit: 20 });
  return finalFeaturePass(opts);
}
