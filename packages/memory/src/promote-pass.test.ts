import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recordOwnerMessage } from "./active-hours.js";
import { enforceByteCap, runPromotePass, setKeepLocal, type PassDeps, type TopicOutcome } from "./promote-pass.js";
import { readPromoteState, updateTopicState } from "./promote-state.js";
import { readRoutingIndex } from "./routing-index.js";
import { readTopics, writeTopic } from "./session/memory.js";

/** A den and its session-topic root; owner messages at each given UTC hour (all on 2026-11-13). */
function setup(activeHours: number[] = []) {
  const den = mkdtempSync(join(tmpdir(), "pass-"));
  const root = join(den, ".memory", "sessions", "durable");
  for (const h of activeHours) recordOwnerMessage(den, new Date(`2026-11-13T${String(h).padStart(2, "0")}:10:00Z`));
  return { den, root };
}
const topic = (root: string, id: string, extra: Partial<Parameters<typeof writeTopic>[1]> = {}) =>
  writeTopic(root, { id, title: id, summary: "s", updated: "2026-11-13 00:00", body: `body ${id}`, sources: ["thread:1"], lastNote: "2026-11-13T00:05:00.000Z", ...extra });

/** Deps whose KB answers `outcomes[id]` after promote; records which topics were promoted. */
function deps(outcomes: Record<string, TopicOutcome>, promoted: string[] = []): PassDeps {
  return {
    promote: async (ts) => { promoted.push(...ts.map((t) => t.id)); },
    outcomeOf: (t) => outcomes[t.id] ?? { kind: "pending" },
    resolveEntry: (id) => id,
    rewriteHeld: async () => false,
  };
}
const NOW = new Date("2026-11-13T23:30:00Z");
const ids = (root: string) => readTopics(root).map((t) => t.id).sort();

describe("promote pass", () => {
  it("owner click promotes every topic except keep-local, and a confirmed topic stays local while still active", async () => {
    const { den, root } = setup([20]);
    topic(root, "a"); topic(root, "b", { keepLocal: true });
    const promoted: string[] = [];
    await runPromotePass({ den, root, trigger: { kind: "owner" }, now: NOW, ...deps({ a: { kind: "create", entryIds: ["kb-a"] } }, promoted) });
    expect(promoted).toEqual(["a"]);
    expect(ids(root)).toEqual(["a", "b"]); // a: promoted + confirmed but only 1 active hour since its last note
    expect(readRoutingIndex(den).subjects.a.entryIds).toEqual(["kb-a"]);
    expect(readPromoteState(den).topics.a.receipt).toEqual({ outcome: "create", entryIds: ["kb-a"] });
  });

  it("retires a promoted, confirmed topic after 8 active hours, into retired/, never deleting it", async () => {
    const { den, root } = setup([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    topic(root, "a");
    await runPromotePass({ den, root, trigger: { kind: "owner" }, now: NOW, ...deps({ a: { kind: "create", entryIds: ["kb-a"] } }) });
    expect(ids(root)).toEqual([]);
    expect(existsSync(join(root, "retired", "a.md"))).toBe(true);
    expect(readPromoteState(den).topics.a.retiredAt).toBe(NOW.toISOString());
  });

  it("does not retire an unpromoted topic however long it has been quiet, and the daily pass promotes only topics whose threads are quiet 8 active hours", async () => {
    const { den, root } = setup([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    topic(root, "quiet");
    topic(root, "fresh", { lastNote: "2026-11-13T07:30:00.000Z" }); // only hours 8 and 9 follow
    const promoted: string[] = [];
    await runPromotePass({ den, root, trigger: { kind: "daily" }, now: NOW, ...deps({}, promoted) });
    expect(promoted).toEqual(["quiet"]);
    expect(ids(root)).toEqual(["fresh", "quiet"]);
  });

  it("a graduation promotes only topics sourced from that feature", async () => {
    const { den, root } = setup([20]);
    topic(root, "mine", { sources: ["work-wolfpack-F1"] }); topic(root, "other");
    const promoted: string[] = [];
    await runPromotePass({ den, root, trigger: { kind: "graduation", featureId: "work-wolfpack-F1" }, now: NOW, ...deps({}, promoted) });
    expect(promoted).toEqual(["mine"]);
  });

  it("a reject retires the topic quietly and leaves a reject marker, with no routing target", async () => {
    const { den, root } = setup([20]);
    topic(root, "a");
    await runPromotePass({ den, root, trigger: { kind: "owner" }, now: NOW, ...deps({ a: { kind: "reject" } }) });
    expect(existsSync(join(root, "retired", "a.md"))).toBe(true);
    expect(readRoutingIndex(den).subjects.a.entryIds).toEqual([]);
    expect(readRoutingIndex(den).subjects.a.rejectedAt).toBeDefined();
  });

  it("a parked topic stays and is marked state: parked", async () => {
    const { den, root } = setup([20]);
    topic(root, "a");
    await runPromotePass({ den, root, trigger: { kind: "owner" }, now: NOW, ...deps({ a: { kind: "parked" } }) });
    expect(readTopics(root)[0]).toMatchObject({ id: "a", state: "parked" });
  });

  it("a held topic whose forced rewrite succeeds is promoted again in the same pass, with the held reason passed to the rewrite", async () => {
    const { den, root } = setup([20]);
    topic(root, "a");
    const promoted: string[] = [];
    const reasons: string[] = [];
    let answers = 0;
    const d: PassDeps = {
      ...deps({}, promoted),
      outcomeOf: () => (answers++ === 0 ? { kind: "held", reason: "distill: log-like" } : { kind: "create", entryIds: ["kb-a"] }),
      rewriteHeld: async (_t, reason) => { reasons.push(reason); return true; },
    };
    const r = await runPromotePass({ den, root, trigger: { kind: "owner" }, now: NOW, ...d });
    expect(reasons).toEqual(["distill: log-like"]);
    expect(promoted).toEqual(["a", "a"]);
    expect(r.retired).toEqual([]);
    expect(readPromoteState(den).topics.a.receipt).toEqual({ outcome: "create", entryIds: ["kb-a"] });
  });

  it("a held topic gets one forced rewrite, then is retired if still held", async () => {
    const { den, root } = setup([20]);
    topic(root, "a");
    let rewrites = 0;
    const d = { ...deps({ a: { kind: "held", reason: "distill: log-like" } }), rewriteHeld: async () => { rewrites++; return false; } };
    await runPromotePass({ den, root, trigger: { kind: "owner" }, now: NOW, ...d });
    expect(ids(root)).toEqual(["a"]); // first pass: rewritten once, kept for the retry
    await runPromotePass({ den, root, trigger: { kind: "owner" }, now: NOW, ...d });
    expect(rewrites).toBe(1);
    expect(existsSync(join(root, "retired", "a.md"))).toBe(true);
  });

  it("over the byte cap, retires the least recently updated confirmed topic first, then evicts unconfirmed ones, never keep-local", async () => {
    const { den, root } = setup([20]);
    const big = "x".repeat(50);
    topic(root, "old-confirmed", { body: big, updated: "2026-11-01 00:00" });
    topic(root, "new-confirmed", { body: big, updated: "2026-11-12 00:00" });
    topic(root, "old-plain", { body: big, updated: "2026-11-02 00:00" });
    topic(root, "pinned", { body: big, updated: "2026-10-01 00:00", keepLocal: true });
    for (const id of ["old-confirmed", "new-confirmed"]) updateTopicState(den, id, { promotedAt: "2026-11-12T00:00:00.000Z", receipt: { outcome: "create", entryIds: ["kb-x"] } });
    const r = enforceByteCap({ den, root, maxBytes: 450, now: NOW });
    expect(r.retired).toEqual(["old-confirmed"]);
    expect(r.evicted).toEqual(["old-plain"]);
    expect(ids(root)).toEqual(["new-confirmed", "pinned"]);
    expect(existsSync(join(root, "evicted", "old-plain.md"))).toBe(true);
  });

  it("keep-local set on a topic survives a rewrite and stops the daily pass promoting it; clearing it makes it eligible again", async () => {
    const { den, root } = setup([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    topic(root, "a");
    expect(setKeepLocal(root, "a", true)).toBe(true);
    expect(setKeepLocal(root, "missing", true)).toBe(false);
    expect(readTopics(root)[0]).toMatchObject({ id: "a", keepLocal: true, sources: ["thread:1"] });
    const promoted: string[] = [];
    await runPromotePass({ den, root, trigger: { kind: "daily" }, now: NOW, ...deps({}, promoted) });
    expect(promoted).toEqual([]);
    setKeepLocal(root, "a", false);
    await runPromotePass({ den, root, trigger: { kind: "daily" }, now: NOW, ...deps({}, promoted) });
    expect(promoted).toEqual(["a"]);
  });

  it("drops a stale routing link when its entry resolves to nothing", async () => {
    const { den, root } = setup([20]);
    topic(root, "a");
    await runPromotePass({ den, root, trigger: { kind: "owner" }, now: NOW, ...deps({ a: { kind: "create", entryIds: ["kb-a"] } }) });
    // a later topic on the same subject: the hint is resolved at use time; the entry was retired with no survivor
    const hint = (await import("./routing-index.js")).routingHint(den, "a", () => null);
    expect(hint).toBeNull();
    expect(JSON.parse(readFileSync(join(den, "memory", "routing-index.json"), "utf8")).subjects.a).toBeUndefined();
  });
});
