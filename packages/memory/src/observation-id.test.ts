import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { observationHash, observationIds } from "./observation-id.js";

const o = { recordedAt: "2026-10-27T10:00:01Z", timestamp: "2026-10-27T10:00:00Z", content: "chose a TTL cache" };

describe("observation ids", () => {
  it("are 16 hex of sha1 over recordedAt, timestamp, content (the route's scheme)", () => {
    const want = createHash("sha1").update(`${o.recordedAt}\u0000${o.timestamp}\u0000${o.content}`).digest("hex").slice(0, 16);
    expect(observationHash(o)).toBe(want);
    expect(observationIds([o])).toEqual([want]);
  });

  it("do not depend on position, other entries or the process", () => {
    const other = { ...o, content: "something else" };
    expect(observationIds([other, o])[1]).toBe(observationIds([o])[0]);
    const child = execFileSync("node", ["-e", `process.stdout.write(require("crypto").createHash("sha1").update(${JSON.stringify(`${o.recordedAt}\u0000${o.timestamp}\u0000${o.content}`)}).digest("hex").slice(0,16))`]).toString();
    expect(observationHash(o)).toBe(child);
  });

  it("tell identical entries apart by ordinal, in pool order", () => {
    const [a, b, c] = observationIds([o, o, o]);
    expect(b).toBe(`${a}-1`);
    expect(c).toBe(`${a}-2`);
  });

  it("change with any field", () => {
    expect(new Set([o, { ...o, recordedAt: "x" }, { ...o, timestamp: "x" }, { ...o, content: "x" }].map(observationHash)).size).toBe(4);
  });
});
