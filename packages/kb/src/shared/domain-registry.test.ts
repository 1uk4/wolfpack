import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatDomainChoices, listSubscribedDomains } from "./domain-registry.js";

function kb(): string {
  const base = mkdtempSync(join(tmpdir(), "kb-dom-"));
  for (const d of ["alpha", "beta", "_hidden"]) mkdirSync(join(base, "domains", d), { recursive: true });
  writeFileSync(join(base, "domains.yaml"), "domains:\n  alpha:\n    label: Alpha\n    description: The A one\n");
  return base;
}

describe("listSubscribedDomains", () => {
  it("lists mirrored domain folders with registry labels", () => {
    expect(listSubscribedDomains(kb(), {})).toEqual([
      { name: "alpha", label: "Alpha", description: "The A one" },
      { name: "beta" },
    ]);
  });
  it("WOLF_DOMAINS wins over folders", () => {
    const got = listSubscribedDomains(kb(), { WOLF_DOMAINS: "beta, gamma" });
    expect(got.map((d) => d.name)).toEqual(["beta", "gamma"]);
  });
  it("is empty with nothing configured", () => {
    expect(listSubscribedDomains(undefined, {})).toEqual([]);
    expect(formatDomainChoices([])).toBe("one of your subscribed domains");
  });
  it("formats choices", () => {
    expect(formatDomainChoices([{ name: "a" }, { name: "b" }])).toBe("a | b");
  });
});
