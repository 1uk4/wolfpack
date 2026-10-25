import { describe, expect, it } from "vitest";
import { MockConsoleClient, type ConsoleClient } from "./index.js";
import { parseThreadEvent } from "@wolfpack/protocol";
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
