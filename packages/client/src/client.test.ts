import { describe, expect, it } from "vitest";
import { MockConsoleClient, type ConsoleClient } from "./index.js";
import { parseThreadEvent, ROUTES } from "@wolfpack/protocol";
import { collect, homeThread, runBehaviours } from "./behaviours.js";

const make = (): ConsoleClient => new MockConsoleClient({ delayMs: 1 });

runBehaviours("mock", make);

describe("MockConsoleClient ↔ @wolfpack/protocol", () => {
  it("every event of a scripted turn validates as a known protocol event", async () => {
    const c = make();
    const id = await homeThread(c);
    await c.submit(id, "hi");
    const events = await collect(c.watch(id));
    expect(events.length).toBeGreaterThan(2);
    for (const e of events) {
      const parsed = parseThreadEvent(e);
      expect(parsed.kind).toBe("event");
      expect(e.actor).toEqual({ id: "1uk4", kind: "wolf" });
    }
  });
});

describe("MockConsoleClient work fixtures ↔ protocol schemas", () => {
  it("listWork and getWorkRecord answer schema-valid fixtures", async () => {
    const c = new MockConsoleClient({ delayMs: 1 });
    const list = await c.listWork!("1uk4", { domain: "wolfpack" });
    expect(ROUTES.listWork.response.schema.parse(list)).toEqual(list);
    expect(list.items.map((i) => i.id)).not.toContain("work-wolfpack-old0001"); // graduated: hidden by default
    expect((await c.listWork!("1uk4", { domain: "wolfpack", graduated: true })).items.map((i) => i.id)).toContain("work-wolfpack-old0001");
    expect((await c.listWork!("1uk4", { domain: "nope" })).items).toEqual([]);
    const rec = await c.getWorkRecord!("1uk4", "work-wolfpack-feat001");
    expect(ROUTES.getWorkRecord.response.schema.parse(rec)).toEqual(rec);
    expect(rec.children).toHaveLength(2);
    await expect(c.getWorkRecord!("1uk4", "work-wolfpack-zzzzzzz")).rejects.toThrow();
  });
});
