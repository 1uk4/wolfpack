import { afterEach, describe, expect, it, vi } from "vitest";
import { readWorkRecord } from "./memory-read.js";

afterEach(() => vi.unstubAllGlobals());

const body = (log: string[]) => `# T\n\n## Plan\n\nthe plan\n\n## Log\n\n${log.map((l) => `- ${l}`).join("\n")}\n`;
const stub = (b: string) => vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, json: async () => ({ item: { id: "w1", title: "T", kind: "task", stage: "plan" }, body: b }) }));

describe("readWorkRecord log", () => {
  it("carries the newest 10 ledger entries, oldest first, and keeps the plan free of the Log", async () => {
    stub(body(Array.from({ length: 12 }, (_, i) => `**2026-10-${10 + i}** — e${i}`)));
    const r = await readWorkRecord("w1", { endpoint: "http://x", token: "t" });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.value.log).toHaveLength(10);
    expect(r.value.log![0]).toContain("e2");
    expect(r.value.log![9]).toContain("e11");
    expect(r.value.plan).not.toContain("Log");
  });

  it("omits log when the item has none", async () => {
    stub("# T\n\n## Plan\n\nonly a plan\n");
    const r = await readWorkRecord("w1", { endpoint: "http://x", token: "t" });
    expect(r.kind === "ok" && "log" in r.value).toBe(false);
  });
});
