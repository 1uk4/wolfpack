import { describe, expect, it } from "vitest";
import { WORK_OBSERVATIONS_CHANNEL as MEMORY_CHANNEL, RECORDED_REPORT_KEY as MEMORY_KEY, createOrchestrator, serializeBranchEntries, type AgentRuntime } from "@wolfpack/memory";
import {
  WORK_OBSERVATIONS_CHANNEL,
  RECORDED_REPORT_KEY,
  deliverWorkReport,
  fetchWorkItemRef,
  prependWorkItem,
  reportToLines,
} from "./work-attribution.ts";

const REPORT = [
  "## Decisions",
  "",
  "Cache reads in WorkClient with a 10s TTL because the server fold is cheap and the cost is the round trip.",
  "",
  "## Build/test",
  "",
  "npx vitest run: 41 pass.",
  "",
  "## Not done",
  "",
  "nothing",
].join("\n");

describe("constants shared with memory", () => {
  it("channel and marker equal the ones in @wolfpack/memory", () => {
    expect(WORK_OBSERVATIONS_CHANNEL).toBe(MEMORY_CHANNEL);
    expect(RECORDED_REPORT_KEY).toBe(MEMORY_KEY);
  });
});

describe("prependWorkItem", () => {
  it("puts one line first, with the title when known", () => {
    expect(prependWorkItem("Do it.", { id: "work-1", title: "Fix cache" })).toBe("You're working on work-1 (Fix cache).\n\nDo it.");
    expect(prependWorkItem("Do it.", { id: "work-1" })).toBe("You're working on work-1.\n\nDo it.");
  });
});

describe("fetchWorkItemRef", () => {
  const ok = (item: object) => (async () => new Response(JSON.stringify({ item }), { status: 200 })) as unknown as typeof fetch;
  it("reads title and parent", async () => {
    expect(await fetchWorkItemRef("w1", { endpoint: "http://x", token: "t", fetchImpl: ok({ title: "T", partOf: "f1" }) })).toEqual({ id: "w1", title: "T", partOf: "f1" });
  });
  it("is null when unconfigured, failing, or slow", async () => {
    expect(await fetchWorkItemRef("w1", { endpoint: "", token: "" })).toBeNull();
    expect(await fetchWorkItemRef("w1", { endpoint: "http://x", token: "t", fetchImpl: (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch })).toBeNull();
    expect(await fetchWorkItemRef("w1", { endpoint: "http://x", token: "t", fetchImpl: (async () => { throw new Error("down"); }) as unknown as typeof fetch })).toBeNull();
  });
});

describe("reportToLines", () => {
  it("joins headings with their text, prefixes the source, keeps a short report in one piece", () => {
    const lines = reportToLines(REPORT, "worker-1");
    expect(lines.every((l) => l.startsWith("[subagent worker-1] "))).toBe(true);
    expect(lines[0]).toContain("## Decisions");
    expect(lines[0]).toContain("10s TTL");
    expect(lines).toHaveLength(1); // a short report stays one piece
  });
  it("caps the number and size of lines", () => {
    const big = Array.from({ length: 80 }, (_, i) => `paragraph ${i} ${"x".repeat(900)}`).join("\n\n");
    const lines = reportToLines(big, "w");
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(lines.every((l) => l.length <= 1500 + 30)).toBe(true);
  });
  it("is empty for an empty report", () => {
    expect(reportToLines("  \n\n ", "w")).toEqual([]);
  });
});

describe("deliverWorkReport", () => {
  const bus = () => {
    const sent: Array<{ channel: string; data: any }> = [];
    return { sent, emit: (channel: string, data: unknown) => sent.push({ channel, data }) };
  };

  it("emits tagged lines with the item, its feature and the source; marks the message", () => {
    const b = bus();
    const details = deliverWorkReport(b, { id: "work-t1", title: "T", partOf: "work-f1" }, "worker-1", { exitCode: 0, summary: REPORT });
    expect(details).toEqual({ workItem: "work-t1", recordedToWork: true });
    expect(b.sent).toHaveLength(1);
    expect(b.sent[0].channel).toBe(MEMORY_CHANNEL);
    expect(b.sent[0].data).toMatchObject({ work: "work-t1", feature: "work-f1", source: "subagent:worker-1" });
    expect(b.sent[0].data.contents[0]).toContain("10s TTL");
  });

  it("a failed or empty run records nothing but is still marked", () => {
    const b = bus();
    expect(deliverWorkReport(b, { id: "w" }, "x", { exitCode: 1, summary: "boom" })).toMatchObject({ recordedToWork: true });
    expect(deliverWorkReport(b, { id: "w" }, "x", { exitCode: 0, summary: "ok", errorMessage: "provider" })).toMatchObject({ recordedToWork: true });
    expect(deliverWorkReport(b, { id: "w" }, "x", { exitCode: 0, summary: "  " })).toMatchObject({ recordedToWork: true });
    expect(b.sent).toEqual([]);
  });

  it("no feature key when the item has no parent", () => {
    const b = bus();
    deliverWorkReport(b, { id: "w", partOf: null }, "x", { exitCode: 0, summary: REPORT });
    expect(b.sent[0].data.feature).toBeUndefined();
  });
});

describe("end to end with memory", () => {
  it("the emitted lines land in the pool tagged; the marked steer message is skipped by the observer, an unmarked one is untouched", () => {
    const runtime: AgentRuntime = { name: "t", cwd: "/nonexistent-scratch", sessionId: "s", getNewChunks: () => [], appendLedger: () => {}, readLedger: () => [], on: () => () => {} };
    const orch = createOrchestrator({} as never, runtime, { consolidateAtPoolTokens: 1e9 });
    const bus = { emit: (_c: string, data: any) => orch.recordWorkObservations(data) };
    const details = deliverWorkReport(bus, { id: "work-t1", partOf: "work-f1" }, "worker-1", { exitCode: 0, summary: REPORT });

    const pool = orch.getActiveObservations();
    expect(pool.length).toBeGreaterThan(0);
    expect(pool.every((o) => o.work === "work-t1" && o.feature === "work-f1" && o.source === "subagent:worker-1")).toBe(true);

    const entry = (id: string, d: object) => ({ id, type: "custom_message", customType: "subagent_result", content: REPORT, details: d });
    const asMessage = (id: string, d: object) => ({ id, type: "message", message: { role: "user", content: REPORT, details: d } });
    expect(serializeBranchEntries([entry("marked", details), asMessage("marked2", details)])).toEqual([]);
    // an unmarked report behaves as before: pi's custom_message entries are not conversation (not read) ...
    expect(serializeBranchEntries([entry("plain", { name: "worker-2" })])).toEqual([]);
    // ... and if it ever arrives as a plain message it is read like any other
    expect(serializeBranchEntries([asMessage("plain2", { name: "worker-2" })]).map((c) => c.id)).toEqual(["plain2"]);
  });
});
