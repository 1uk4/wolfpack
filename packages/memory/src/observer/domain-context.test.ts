import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildDomainContext } from "./domain-context.js";

describe("buildDomainContext", () => {
  let kbBase: string;
  beforeEach(() => {
    kbBase = mkdtempSync(join(tmpdir(), "domctx-"));
    writeFileSync(
      join(kbBase, "domains.yaml"),
      [
        "domains:",
        "  wolfpack:",
        "    label: Wolfpack",
        "    description: The agent framework, its code,",
        "      agents and infrastructure.",
        "  personal:",
        "    label: Personal",
        "    description: The user's life and fitness.",
      ].join("\n")
    );
  });
  afterEach(() => rmSync(kbBase, { recursive: true, force: true }));

  it("uses descriptions from the domains.yaml registry", () => {
    const ctx = buildDomainContext(["wolfpack", "personal"], kbBase);
    expect(ctx).toContain("- wolfpack: The agent framework, its code, agents and infrastructure.");
    expect(ctx).toContain("- personal: The user's life and fitness.");
  });

  it("tells the classifier to classify software work by the software's owner", () => {
    expect(buildDomainContext(["wolfpack", "personal"], kbBase)).toContain("Classify by SUBJECT");
  });
});
