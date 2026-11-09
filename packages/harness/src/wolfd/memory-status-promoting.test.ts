import { describe, expect, it } from "vitest";
import { readMemoryStatus } from "./memory-read.js";

const input = { den: undefined, extensionInstalled: true, running: false, config: { sandbox: false, consolidation: { threshold: 1, poolTarget: 1, trigger: "manual" as const } } };

describe("memory status: a running promote", () => {
  it("names the in-flight promote job, and omits it when none runs", async () => {
    expect((await readMemoryStatus(input, null, null, "promote-abc-1")).promoting).toEqual({ jobId: "promote-abc-1" });
    expect("promoting" in (await readMemoryStatus(input, null, null, null))).toBe(false);
  });
});
