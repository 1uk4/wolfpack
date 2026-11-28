import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash, type KbRoots } from "@wolfpack/kb/shared";
import { writeDenTopic } from "./den.js";
import { denTopicStates, kbOutcome } from "./den-reconcile.js";
import { runPromotePass } from "./promote-pass.js";
import { readPromoteState } from "./promote-state.js";
import { writeTopic } from "./session/memory.js";
import { seedActiveHours } from "./active-hours.js";

const WOLF = "w1";
let base: string;
let roots: KbRoots;
let den: string;
let sessionRoot: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "skip-receipt-"));
  roots = { kbBase: join(base, "kb"), opsRoot: join(base, "ops"), denLocal: join(base, "den", "kb") };
  den = join(base, "den");
  sessionRoot = join(base, "session");
  // The den file and the session copy differ: the KB absorbed the session body (consolidate's skip rule compares it).
  writeDenTopic(den, { id: "t", title: "T", summary: "s", updated: "2026-10-01 00:00", body: "den body" });
  writeTopic(sessionRoot, { id: "t", title: "T", summary: "s", updated: "2026-10-01 00:00", body: "session body" });
  // Quiet: 10 active hours since the topic's last update.
  seedActiveHours(den, Array.from({ length: 10 }, (_, i) => new Date(Date.UTC(2026, 10, 2, i))));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const receipt = (body: string) => {
  const dir = join(roots.opsRoot, "receipts", WOLF);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `t-${contentHash(body.trim()).slice(7, 17)}.md`), `---\nfrom: ${WOLF}\nden_topic_id: t\noutcome: merge\nprocessed: 2026-10-22 10:00\n---\n\nkb-wolfpack-AAAAAAA\n`);
};

const pass = (outcomeOf: () => ReturnType<typeof kbOutcome>, promote = async () => {}) =>
  runPromotePass({ den, root: sessionRoot, trigger: { kind: "daily" }, now: new Date("2026-11-27T00:00:00Z"), promote, outcomeOf, resolveEntry: () => null, rewriteHeld: async () => false });

describe("a topic the skip rule judged already in the KB", () => {
  it("is recorded as promoted with the matching entry id, and the next pass leaves it done", async () => {
    receipt("session body");
    expect(denTopicStates(den, roots, WOLF)[0].status.kind).toBe("pending-promote"); // the stuck state
    const outcomeOf = () => kbOutcome(den, roots, WOLF, { id: "t" }, ["den body", "session body"]);
    const sent: string[] = [];
    const first = await pass(outcomeOf, async () => { sent.push("first"); });
    expect(readPromoteState(den).topics.t).toMatchObject({ receipt: { outcome: "create", entryIds: ["kb-wolfpack-AAAAAAA"] } });
    expect(readPromoteState(den).topics.t.promotedAt).toBe("2026-11-27T00:00:00.000Z");
    expect(first.retired).toEqual(["t"]); // promoted + receipt + quiet: the retire rule applies
    await pass(outcomeOf, async () => { sent.push("second"); });
    expect(sent).toEqual(["first"]); // the next pass does not pick it up again
  });

  it("stays pending and is sent again when nothing in the KB matches", async () => {
    const sent: string[][] = [];
    const outcomeOf = () => kbOutcome(den, roots, WOLF, { id: "t" }, ["den body", "session body"]);
    await pass(outcomeOf, async () => { sent.push(["t"]); });
    await pass(outcomeOf, async () => { sent.push(["t"]); });
    expect(readPromoteState(den).topics.t?.receipt).toBeUndefined();
    expect(sent).toHaveLength(2);
    expect(denTopicStates(den, roots, WOLF)[0].status.kind).toBe("pending-promote");
  });
});
