import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "@wolfpack/engine";
import { type KbRoots } from "@wolfpack/kb/shared";
import { consolidateSession } from "./consolidate.js";
import { writeDenTopic } from "./den.js";
import { denTopicStates, kbOutcome } from "./den-reconcile.js";
import { readDistillRecord } from "./distill.js";
import { updateTopicState } from "./promote-state.js";
import { writeTopic } from "./session/memory.js";

const WOLF = "w1";
let base: string;
let roots: KbRoots;
let den: string;
let memoryRoot: string;

beforeEach(() => {
  vi.stubEnv("KB_DOMAINS", "");
  base = mkdtempSync(join(tmpdir(), "den-only-"));
  roots = { kbBase: join(base, "kb"), opsRoot: join(base, "ops"), denLocal: join(base, "den", "kb") };
  den = join(base, "den");
  memoryRoot = join(base, "sessions");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

const clean = { slug: "main", title: "Owner merges pull requests", summary: "Only the owner merges.", body: "## Rule\nNever run gh pr merge." };
const engine = { call: async (_s: string, schema: { parse: (v: unknown) => unknown }) => schema.parse({ contributions: [clean] }) } as unknown as Engine;
const inbox = () => (existsSync(join(roots.opsRoot, "inbox", WOLF)) ? readdirSync(join(roots.opsRoot, "inbox", WOLF)) : []);
const promote = (onlyIds: string[]) =>
  consolidateSession({ engine, den: { denRoot: den, wolfName: WOLF }, memoryRoot, sessionId: "durable", kbRoots: roots, defaultDomain: "wolfpack", onlyIds });

describe("promote of a den-only topic (no session copy)", () => {
  it("emits the chosen topic to the KB inbox, and it is recorded once a receipt appears", async () => {
    writeDenTopic(den, { id: "only-den", title: "Only den", summary: "s", updated: "2026-11-01 00:00", body: "den only body" });
    const r = await promote(["only-den"]);
    expect(r.claimsSubmitted).toBe(1);
    expect(inbox()).toHaveLength(1);
    expect(denTopicStates(den, roots, WOLF)[0].status.kind).toBe("awaiting-sweep");

    const out = readDistillRecord(roots, "only-den")!.outputs[0];
    const dir = join(roots.opsRoot, "receipts", WOLF);
    mkdirSync(dir, { recursive: true });
    const stem = inbox()[0]!; // the sweep names its receipt like the inbox file it answers: `<id>-<hash10>.md`
    expect(out.id).toBe("only-den");
    writeFileSync(join(dir, stem), `---\nfrom: ${WOLF}\nden_topic_id: only-den\noutcome: create\nprocessed: 2026-11-27 10:00\n---\n\nkb-wolfpack-BBBBBBB\n`);
    expect(kbOutcome(den, roots, WOLF, { id: "only-den" }, ["den only body"])).toEqual({ kind: "create", entryIds: ["kb-wolfpack-BBBBBBB"] });
  });

  it("does not emit a topic with both a den file and a session copy twice", async () => {
    writeTopic(join(memoryRoot, "durable"), { id: "both", title: "Both", summary: "s", updated: "2026-11-01 00:00", body: "same body" });
    writeDenTopic(den, { id: "both", title: "Both", summary: "s", updated: "2026-11-01 00:00", body: "same body" });
    const r = await promote(["both"]);
    expect(r.claimsSubmitted).toBe(1);
    expect(inbox()).toHaveLength(1);
  });

  const rawDen = (id: string, front: string, body = "raw den body") => {
    mkdirSync(join(den, "memory", "topics"), { recursive: true });
    writeFileSync(join(den, "memory", "topics", `${id}.md`), `---\nid: ${id}\ntitle: ${id}\nsummary: s\nupdated: 2026-11-01 00:00\n${front}---\n\n${body}\n`);
  };

  it("emits a den-only topic the owner edited by hand (its session_hash no longer matches its body)", async () => {
    rawDen("hand", "session_hash: 0000000000000000\n");
    const r = await promote(["hand"]);
    expect(r.claimsSubmitted).toBe(1);
  });

  it("never emits a work-tagged den-only topic: work knowledge reaches the KB only through graduation", async () => {
    rawDen("tagged", "work: work-wolfpack-AAAAAAA\n");
    const r = await promote(["tagged"]);
    expect(r.claimsSubmitted).toBe(0);
    expect(inbox()).toHaveLength(0);
  });

  it("does not emit a parked den-only topic", async () => {
    writeDenTopic(den, { id: "parked", title: "Parked", summary: "s", updated: "2026-11-01 00:00", body: "parked body" });
    updateTopicState(den, "parked", { state: "parked" });
    const r = await promote(["parked"]);
    expect(r.claimsSubmitted).toBe(0);
    expect(inbox()).toHaveLength(0);
  });

  it("a den topic whose session copy sits only under <id>-evicted-... is emitted once when both ids are chosen", async () => {
    writeDenTopic(den, { id: "ev", title: "Ev", summary: "s", updated: "2026-11-01 00:00", body: "evicted body" });
    writeTopic(join(memoryRoot, "durable", "evicted"), { id: "ev-evicted-abc", title: "Ev", summary: "s", updated: "2026-11-01 00:00", body: "evicted body" });
    const r = await promote(["ev", "ev-evicted-abc"]);
    expect(r.claimsSubmitted).toBe(1);
    expect(inbox()).toHaveLength(1);
  });

  it("does not emit a den topic held with promotable: false", async () => {
    writeDenTopic(den, { id: "held", title: "Held", summary: "s", updated: "2026-11-01 00:00", body: "log body", promotable: false, promotableReason: "reads as a log" });
    const r = await promote(["held"]);
    expect(r.claimsSubmitted).toBe(0);
    expect(inbox()).toHaveLength(0);
  });
});
