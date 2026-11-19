import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recordReject, recordRouting, routingHint, readRoutingIndex } from "./routing-index.js";
import { dailyPassDue, markDailyPass, readPromoteState, updateTopicState } from "./promote-state.js";
import { recordOwnerMessage } from "./active-hours.js";

const den = () => mkdtempSync(join(tmpdir(), "routing-"));

describe("routing index", () => {
  it("records every receipt target, primary first, and hints the primary through the injected resolver", () => {
    const d = den();
    recordRouting(d, "Deploy Pipeline", ["kb-a", "kb-b"], new Date("2026-11-13T09:00:00Z"));
    expect(JSON.parse(readFileSync(join(d, "memory", "routing-index.json"), "utf8")).subjects["deploy pipeline"].entryIds).toEqual(["kb-a", "kb-b"]);
    expect(routingHint(d, "deploy pipeline", (id) => id)).toBe("kb-a");
  });

  it("follows a retired entry to its survivor and rewrites the link", () => {
    const d = den();
    recordRouting(d, "s", ["kb-old"]);
    expect(routingHint(d, "s", (id) => (id === "kb-old" ? "kb-new" : id))).toBe("kb-new");
    expect(readRoutingIndex(d).subjects.s.entryIds).toEqual(["kb-new"]);
  });

  it("drops a stale link that resolves to nothing", () => {
    const d = den();
    recordRouting(d, "s", ["kb-gone"]);
    expect(routingHint(d, "s", () => null)).toBeNull();
    expect(readRoutingIndex(d).subjects.s).toBeUndefined();
  });

  it("records a reject marker that gives no target hint but keeps the subject promotable", () => {
    const d = den();
    recordReject(d, "s", new Date("2026-11-13T09:00:00Z"));
    expect(readRoutingIndex(d).subjects.s).toEqual({ entryIds: [], rejectedAt: "2026-11-13T09:00:00.000Z" });
    expect(routingHint(d, "s", (id) => id)).toBeNull();
  });
});

describe("promote state", () => {
  it("keeps per-topic promote facts across reads", () => {
    const d = den();
    updateTopicState(d, "t1", { promotedAt: "2026-11-13T09:00:00.000Z", receipt: { outcome: "create", entryIds: ["kb-a"] } });
    updateTopicState(d, "t1", { retiredAt: "2026-11-14T09:00:00.000Z" });
    expect(readPromoteState(d).topics.t1).toEqual({
      promotedAt: "2026-11-13T09:00:00.000Z",
      receipt: { outcome: "create", entryIds: ["kb-a"] },
      retiredAt: "2026-11-14T09:00:00.000Z",
    });
  });

  it("runs the daily pass at most once per active day", () => {
    const d = den();
    const now = new Date("2026-11-13T15:00:00Z");
    expect(dailyPassDue(d, now)).toBe(false); // no owner message today: not an active day
    recordOwnerMessage(d, new Date("2026-11-13T09:10:00Z"));
    expect(dailyPassDue(d, now)).toBe(true);
    markDailyPass(d, now);
    expect(dailyPassDue(d, now)).toBe(false);
    recordOwnerMessage(d, new Date("2026-11-14T08:00:00Z"));
    expect(dailyPassDue(d, new Date("2026-11-14T09:00:00Z"))).toBe(true);
  });
});
