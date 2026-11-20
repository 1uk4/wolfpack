import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Open-source readiness: no tracked text file may carry the owner's personal specifics.
// Patterns are assembled from fragments so this file does not match itself.
const PERSONAL = [
  ["100", "120", "154", "69"].join("\\."),
  ["tail4f", "0118"].join(""),
  ["luka", "flores"].join(""),
  ["audemears", "@proton"].join("|"),
];

describe("repo hygiene", () => {
  it("tracks no personal tailnet address, tailnet name, home path or email", () => {
    const re = PERSONAL.join("|");
    let out = "";
    try {
      out = execFileSync("git", ["grep", "-l", "-I", "-E", re, "--", ".", ":!pnpm-lock.yaml"], { encoding: "utf8" });
    } catch (e) {
      // git grep exits 1 when nothing matches
      if ((e as { status?: number }).status !== 1) throw e;
    }
    expect(out.split("\n").filter(Boolean)).toEqual([]);
  });
});
