/**
 * Audit walk: from a graduated entry's contribution to the feature's Record line to the observation in the archive.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import type { WorkItem } from "@wolfpack/kb/client";
import type { KbRoots } from "@wolfpack/kb/shared";
import { confirmGraduation, previewGraduation, type GraduationClient } from "./graduate.js";
import { consolidateWorkRecords, findRecordLine, type WorkRecordStore } from "../work-record.js";
import { appendArchive, findArchived } from "../work-pending.js";
import { observationIds } from "../observation-id.js";

const w = (id: string, kind: string, partOf: string | null, extra: Record<string, unknown> = {}) =>
  ({ id, kind, title: id, partOf, domain: "wp", stage: "shipped", successCriteria: null, created: "2026-10-14", log: [], dependsOn: [], graduated: null, container: false, ...extra }) as unknown as WorkItem;

const PLAN = "## Plan\n\nDo the thing.\n\n";
const subject = (workId: string, recordLines?: string[]) => ({ slug: "rule", title: "A lasting rule", summary: "How X works.", body: `## Rule\n\nAlways [r2].\n\n## History\n\n- 2026-10-22: chose X (${workId})`, ...(recordLines ? { recordLines } : {}) });
const engineOf = (recordLines?: string[]) => {
  const call = vi.fn(async (_s: string, schema: { parse: (v: unknown) => unknown }, o: { prompt: string }) => schema.parse({ contributions: [subject(/WORK ID: (\S+)/.exec(o.prompt)?.[1] ?? "work-wp-FEAT001", recordLines)] }));
  return { engine: { call, usage: { summarize: () => ({}) } } as unknown as Engine, call };
};

describe("graduated entries point back to the Record lines and the archived observations", () => {
  let dir: string;
  let roots: KbRoots;
  let feat: WorkItem, t1: WorkItem, t2: WorkItem;
  const bodies: Record<string, string> = {};
  const inbox = () => join(roots.opsRoot, "inbox", "owner");
  const sent = () => readdirSync(inbox()).map((f) => readFileSync(join(inbox(), f), "utf8"));
  const field = (md: string, k: string) => new RegExp(`^${k}: (.*)$`, "m").exec(md)?.[1];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prov-"));
    roots = { kbBase: join(dir, "kb"), opsRoot: join(dir, "ops"), denLocal: join(dir, "den") };
    feat = w("work-wp-FEAT001", "feature", null);
    t1 = w("work-wp-TASK001", "task", feat.id as string);
    t2 = w("work-wp-TASK002", "task", feat.id as string);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const client = (items: WorkItem[]): GraduationClient => ({
    query: async () => items,
    getWithBody: async (id) => ({ item: items.find((i) => i.id === id)!, body: bodies[id] ?? null }),
    graduate: async (id) => items.find((i) => i.id === id)!,
    stage: async (id) => items.find((i) => i.id === id)!,
    note: async (id) => items.find((i) => i.id === id)!,
  });

  /** Fold three observations into the feature's Record the way consolidation does, and archive them. */
  async function writeRecord(): Promise<string[]> {
    const pool = [0, 1, 2].map((n) => ({ timestamp: `2026-10-20T10:0${n}:00Z`, recordedAt: `2026-10-20T11:0${n}:00Z`, content: `observation ${n}`, work: n === 2 ? t2.id as string : t1.id as string, feature: feat.id as string }));
    const ids = observationIds(pool);
    const store: WorkRecordStore = {
      get: async (id) => ({ id, title: id, kind: "feature", stage: "in_build", body: bodies[id] ?? PLAN }),
      setBody: async (id, body) => { bodies[id] = body; },
    };
    const engine = { call: async (_s: string, schema: { parse: (v: unknown) => unknown }) => schema.parse({
      decisions: [{ decision: "Chose X", why: "simple", from: ["o1", "o2"] }],
      changes: [],
      findings: [{ text: "Y is slow", from: ["o3"] }],
      problems: [],
    }) } as unknown as Engine;
    const out = await consolidateWorkRecords({ engine, store, observations: pool.map((o, i) => ({ id: ids[i], timestamp: o.timestamp, content: o.content, work: o.work, feature: o.feature })) });
    expect(out[0]).toMatchObject({ status: "written", work: feat.id });
    appendArchive(roots.denLocal, pool.map((o, i) => ({ obs: o, id: ids[i], outcome: "written" as const, target: feat.id as string })));
    return ids;
  }

  it("entry → feature + tasks + Record lines → observation ids and timestamps → archived observation", async () => {
    const ids = await writeRecord();
    const { engine } = engineOf();
    const p = await previewGraduation({ client: client([feat, t1, t2]), engine, id: feat.id as string, today: "2026-10-22" });
    await confirmGraduation({ client: client([feat, t1, t2]), roots, wolf: "owner", preview: p, ship: async () => {} });

    const md = sent()[0];
    expect(field(md, "source_feature")).toBe(feat.id);
    expect(field(md, "source_tasks")).toBe(`${t1.id}, ${t2.id}`);
    // the model never saw the source comments, and the entry does not carry them
    expect(md).not.toContain("<!--");
    const refs = field(md, "source_record_lines")!.split(", ");
    expect(refs).toHaveLength(2);
    expect(field(md, "source_record_lines_scope")).toBe("record"); // the model mapped no lines: the whole Record
    expect(md).not.toContain("[r2]"); // marker the model echoed is removed

    const lines = refs.map((r) => findRecordLine(bodies[feat.id as string], r)!);
    expect(lines.map((l) => l.text)).toEqual(["Chose X — why: simple", "Y is slow"]);
    expect(lines[0].sources).toEqual([{ id: ids[0], timestamp: "2026-10-20T10:00:00Z" }, { id: ids[1], timestamp: "2026-10-20T10:01:00Z" }]);
    const walked = lines.flatMap((l) => l.sources).map((s) => findArchived(roots.denLocal, s.id)!);
    expect(walked.map((e) => e.content)).toEqual(["observation 0", "observation 1", "observation 2"]);
    expect(walked.every((e) => e.outcome === "written" && e.target === feat.id)).toBe(true);
    expect(walked.map((e) => e.work)).toEqual([t1.id, t1.id, t2.id]);
  });

  it("when distill maps the entry to Record lines, source-record-lines is just those; the archived document keeps its Record with the comments", async () => {
    const ids = await writeRecord();
    const before = bodies[feat.id as string];
    const { engine, call } = engineOf(["r2"]);
    const p = await previewGraduation({ client: client([feat, t1, t2]), engine, id: feat.id as string, today: "2026-10-22" });
    expect((call.mock.calls[0] as any)[2].prompt).toContain("- [r1] Chose X");
    expect((call.mock.calls[0] as any)[2].prompt).toContain("- [r2] Y is slow");
    expect((call.mock.calls[0] as any)[2].prompt).not.toContain("<!--");
    await confirmGraduation({ client: client([feat, t1, t2]), roots, wolf: "owner", preview: p, ship: async () => {} });
    const md = sent()[0];
    const refs = field(md, "source_record_lines")!.split(", ");
    expect(refs).toHaveLength(1);
    expect(field(md, "source_record_lines_scope")).toBeUndefined();
    const line = findRecordLine(bodies[feat.id as string], refs[0])!;
    expect(line.text).toBe("Y is slow");
    expect(line.sources.map((s) => s.id)).toEqual([ids[2]]);
    // graduation never writes the document (the client has no way to): the Record and its comments are still there
    expect(bodies[feat.id as string]).toBe(before);
    expect(bodies[feat.id as string]).toContain("<!-- src:");
  });

  it("a confirm that re-distills after a late fold carries the same source metadata, with the new line", async () => {
    await writeRecord();
    const { engine } = engineOf();
    const p = await previewGraduation({ client: client([feat, t1, t2]), engine, id: feat.id as string, today: "2026-10-22" });
    const drain = vi.fn(async () => { bodies[feat.id as string] += "\n- Late finding <!-- src: late1@2026-10-21T09:00:00Z -->\n"; return { folded: 1 }; });
    await confirmGraduation({ client: client([feat, t1, t2]), roots, wolf: "owner", preview: p, ship: async () => {}, drain, engine: engineOf().engine, today: "2026-10-22" });
    const md = sent()[0];
    expect(field(md, "source_feature")).toBe(feat.id);
    const refs = field(md, "source_record_lines")!.split(", ");
    expect(refs).toHaveLength(3);
    expect(findRecordLine(bodies[feat.id as string], refs[2])).toMatchObject({ text: "Late finding", sources: [{ id: "late1", timestamp: "2026-10-21T09:00:00Z" }] });
  });
});
