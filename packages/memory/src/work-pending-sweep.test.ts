import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPendingSummary, sweepPending } from "./work-pending.js";

let den: string;
const stateFile = () => join(den, ".memory", "pool", "work-state.json");
const entry = (o: object = {}) => ({ firstPendingAt: 1000, tries: 1, nextAttemptAt: 2000, cause: "work-api-unavailable", ...o });
beforeEach(() => {
  den = mkdtempSync(join(tmpdir(), "pending-sweep-"));
  mkdirSync(join(den, ".memory", "pool"), { recursive: true });
  writeFileSync(stateFile(), JSON.stringify({ "work-spot-5Okxe2v": entry(), "work-spot-Live123": entry() }));
});
afterEach(() => rmSync(den, { recursive: true, force: true }));

describe("pending work saves: stale keys", () => {
  it("drops a key no pooled observation references, from the file and the summary", async () => {
    const dropped = await sweepPending(den, { live: new Set(["work-spot-Live123"]), now: 5000 });
    expect(dropped).toEqual([{ key: "work-spot-5Okxe2v", reason: "no observations" }]);
    expect(Object.keys(JSON.parse(readFileSync(stateFile(), "utf-8")))).toEqual(["work-spot-Live123"]);
    expect(Object.keys(readPendingSummary(den, 5000, new Set(["work-spot-Live123"])).keys)).toEqual(["work-spot-Live123"]);
  });

  it("drops a key whose item is archived, with the reason", async () => {
    const dropped = await sweepPending(den, { live: new Set(["work-spot-5Okxe2v", "work-spot-Live123"]), isArchived: async (k) => k === "work-spot-5Okxe2v", now: 5000 });
    expect(dropped).toEqual([{ key: "work-spot-5Okxe2v", reason: "item archived" }]);
    expect(Object.keys(JSON.parse(readFileSync(stateFile(), "utf-8")))).toEqual(["work-spot-Live123"]);
  });

  it("keeps a key when the archived check cannot reach the hub", async () => {
    const dropped = await sweepPending(den, { live: new Set(["work-spot-5Okxe2v", "work-spot-Live123"]), isArchived: async () => { throw new Error("ECONNREFUSED"); }, now: 5000 });
    expect(dropped).toEqual([]);
  });

  it("surfaces the real error and the try count in the summary", () => {
    writeFileSync(stateFile(), JSON.stringify({ k: entry({ tries: 4, message: "Work API PATCH k: HTTP 502" }) }));
    const s = readPendingSummary(den, 5000);
    expect(s.messages.k).toBe("Work API PATCH k: HTTP 502");
    expect(s.tries.k).toBe(4);
  });
});
