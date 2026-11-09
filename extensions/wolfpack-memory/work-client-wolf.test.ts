/** The hub needs to know which wolf of a multi-wolf host is writing: every request carries X-Wolf, and a move reports the hub's handoff. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkClient } from "./work-client.js";

afterEach(() => vi.unstubAllGlobals());

describe("WorkClient acting wolf", () => {
  it("sends X-Wolf on reads and writes, and surfaces the handoff of a move", async () => {
    const seen: Record<string, string>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers);
      return new Response(JSON.stringify({ item: { id: "work-d-abcd" }, reassigned: [{ id: "work-d-abcd", from: "hal", to: "hal2" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const c = new WorkClient("http://hub/v1/workapi", "tok", undefined, undefined, "hal");
    await c.get("work-d-abcd");
    const moved = await c.moveReport("work-d-abcd", "work-d-feat");
    expect(seen.map((h) => h["X-Wolf"])).toEqual(["hal", "hal"]);
    expect(moved.reassigned).toEqual([{ id: "work-d-abcd", from: "hal", to: "hal2" }]);
  });
});
