import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildStamp, staleBuildWarning } from "./build-stamp.js";

describe("build stamp", () => {
  it("takes the newest non-test code mtime", () => {
    const d = mkdtempSync(join(tmpdir(), "stamp-"));
    writeFileSync(join(d, "a.ts"), "x");
    writeFileSync(join(d, "a.test.ts"), "x");
    utimesSync(join(d, "a.ts"), 1000, 1000);
    utimesSync(join(d, "a.test.ts"), 9000, 9000);
    expect(buildStamp([d, join(d, "missing")])).toBe(1_000_000);
  });

  it("warns when disk code is newer than what the process loaded", () => {
    const d = mkdtempSync(join(tmpdir(), "stamp-"));
    writeFileSync(join(d, "a.ts"), "x");
    utimesSync(join(d, "a.ts"), 5000, 5000);
    expect(staleBuildWarning(5_000_000, { running: [d] })).toBeUndefined();
    expect(staleBuildWarning(2_000_000, { running: [d] })).toMatch(/restart pi/);
  });
});
