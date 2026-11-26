/** show_view kind "frame" against a real frames dir: what it accepts, what it refuses, and the descriptor it emits. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createObjectsExtension, objectFromCall } from "../engine/index.js";
import { FRAME_MAX_BYTES, frameProblem, framesRoot } from "./frames.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "wolf-frame-tool-"));
  mkdirSync(framesRoot(home), { recursive: true });
  writeFileSync(join(framesRoot(home), "pack-health.html"), "<p>ok</p>");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

type Result = { isError?: boolean; output: Array<{ text: string }> };
async function showView(args: Record<string, unknown>): Promise<Result> {
  const ext = createObjectsExtension(home, { wolf: "hal", check: (p) => frameProblem(home, p) });
  const tool = ext.tools!.find((t) => t.name === "show_view")!;
  return (await tool.execute({ kind: "frame", wolf: "hal", objectId: "viz", ...args } as never, {} as never, {} as never)) as Result;
}

describe("show_view kind frame", () => {
  it("accepts an existing file and emits the descriptor the console reads, same objectId for a revision", async () => {
    const r = await showView({ path: "pack-health.html", title: "Pack health" });
    expect(r.isError).toBeFalsy();
    const call = { kind: "frame", wolf: "hal", path: "pack-health.html", title: "Pack health", objectId: "viz" };
    expect(objectFromCall("show_view", call)).toEqual({
      objectId: "viz",
      type: "view",
      data: { kind: "frame", id: "pack-health.html", path: "pack-health.html", wolf: "hal", title: "Pack health" },
    });
    // a second call for the same objectId is just another valid call: the rev rule counts it
    expect((await showView({ path: "pack-health.html" })).isError).toBeFalsy();
  });

  it.each(["../x.html", "/etc/x.html", ".hidden.html", "chart.js"])("rejects the path %s and names the path as the problem", async (path) => {
    expect(objectFromCall("show_view", { kind: "frame", wolf: "hal", path, objectId: "viz" })).toBeUndefined();
    const r = await showView({ path });
    expect(r.isError).toBe(true);
    expect(r.output[0]!.text).toMatch(/^Invalid arguments: path: /);
  });

  it("errors clearly on a missing file and on a file over 2 MB", async () => {
    const missing = await showView({ path: "nope.html" });
    expect(missing.isError).toBe(true);
    expect(missing.output[0]!.text).toContain("No frame file");
    writeFileSync(join(framesRoot(home), "big.html"), Buffer.alloc(FRAME_MAX_BYTES + 1));
    const big = await showView({ path: "big.html" });
    expect(big.isError).toBe(true);
    expect(big.output[0]!.text).toContain("big.html");
  });

  it("refuses another wolf's name", async () => {
    expect((await showView({ path: "pack-health.html", wolf: "jack" })).isError).toBe(true);
  });
});
