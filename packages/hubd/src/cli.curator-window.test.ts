/** Seam: the exported curator-window runner and its env parsing (cli.ts). The SIGUSR2 wiring itself is covered by the desktop live test. */
import { describe, expect, it } from "vitest";
import { curatorWindowMax, makeWindowHandler, runCuratorWindow } from "./cli.js";

type Tick = { outcome: string; processed: number; remaining: number } | undefined;

async function window(max: number, tick: () => Promise<Tick>): Promise<{ lines: string[]; ticks: number }> {
  const lines: string[] = [];
  let ticks = 0;
  await runCuratorWindow(async () => { ticks++; return tick(); }, max, (m) => lines.push(m));
  return { lines, ticks };
}

describe("curator window", () => {
  it("stops at the limit, when empty, when busy, when off, and on an error, and logs one done line", async () => {
    const ran = (remaining: number): Tick => ({ outcome: "ran", processed: 1, remaining });
    const limit = await window(2, async () => ran(3));
    expect(limit.ticks).toBe(2);
    expect(limit.lines).toEqual(["curator window done: processed=2 remaining=3 stop=limit"]);

    expect((await window(5, async () => ran(0))).lines).toEqual(["curator window done: processed=1 remaining=0 stop=empty"]);
    expect((await window(5, async () => ({ outcome: "busy", processed: 0, remaining: 4 }))).lines).toEqual(["curator window done: processed=0 remaining=4 stop=busy"]);
    expect((await window(5, async () => undefined)).lines).toEqual(["curator window done: processed=0 remaining=0 stop=off"]);
    expect((await window(5, async () => { throw new Error("model down\nstack"); })).lines).toEqual(["curator window done: processed=0 remaining=0 stop=error: model down"]);
  });

  it("a second signal while a window runs logs one busy line and starts nothing", async () => {
    const lines: string[] = [];
    let release: (t: Tick) => void = () => {};
    let ticks = 0;
    const handler = makeWindowHandler(() => { ticks++; return new Promise<Tick>((r) => { release = r; }); }, 1, (m) => lines.push(m));
    handler();
    handler();
    expect(lines).toEqual(["curator window skipped: busy"]);
    release({ outcome: "ran", processed: 1, remaining: 2 });
    await new Promise((r) => setTimeout(r, 10));
    expect(ticks).toBe(1);
    expect(lines).toEqual(["curator window skipped: busy", "curator window done: processed=1 remaining=2 stop=limit"]);
  });

  it("reads HUBD_CURATOR_WINDOW_MAX: unset is 0, a number is itself, junk throws", () => {
    expect(curatorWindowMax({})).toBe(0);
    expect(curatorWindowMax({ HUBD_CURATOR_WINDOW_MAX: "5" })).toBe(5);
    expect(() => curatorWindowMax({ HUBD_CURATOR_WINDOW_MAX: "abc" })).toThrow(/HUBD_CURATOR_WINDOW_MAX/);
  });
});
