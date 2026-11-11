import { describe, expect, it } from "vitest";
import { createStallWatch } from "./health.js";

describe("createStallWatch", () => {
  it("logs one warning with the lag in ms when a tick is more than 5 s late, and nothing for a normal tick", () => {
    let t = Date.parse("2026-11-10T15:33:00.000Z");
    const lines: string[] = [];
    const w = createStallWatch({ now: () => t, warn: (l) => lines.push(l) });
    t += 1_050; // on time
    w.tick();
    expect(lines).toEqual([]);
    t += 16_000; // 15 s stall
    w.tick();
    t += 1_000; // recovered: no repeat
    w.tick();
    w.stop();
    expect(lines).toEqual(["2026-11-10T15:33:17.050Z hubd: event loop stalled for 15000 ms (threshold 5000 ms)"]);
  });
});
