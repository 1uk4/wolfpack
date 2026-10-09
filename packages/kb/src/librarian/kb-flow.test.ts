import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KbRoots } from "../shared/index.js";
import { entriesDir, domainIndex, unclassifiedDir } from "../shared/index.js";
import { readDeclaredDomains, isDeclared, renderDomainIndex } from "./domains.js";

let root: string;
let roots: KbRoots;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kb-flow-"));
  roots = {
    kbBase: join(root, "knowledge", "base"),
    opsRoot: join(root, "librarian"),
    denLocal: join(root, "den", "kb"),
  };
  mkdirSync(roots.kbBase, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("declared-domain gate", () => {
  it("returns null when no registry is deployed (unconstrained)", () => {
    expect(readDeclaredDomains(roots)).toBeNull();
    expect(isDeclared(null, "anything")).toBe(true);
  });

  it("reads declared names and gates undeclared", () => {
    writeFileSync(
      join(roots.kbBase, "domains.yaml"),
      "domains:\n  wolfpack:\n    label: Wolfpack\n  snapjack:\n    label: Snapjack\n",
    );
    const declared = readDeclaredDomains(roots)!;
    expect([...declared].sort()).toEqual(["snapjack", "wolfpack"]);
    expect(isDeclared(declared, "wolfpack")).toBe(true);
    expect(isDeclared(declared, "personal")).toBe(false);
  });
});

describe("renderDomainIndex", () => {
  it("builds a catalog from entry frontmatter", () => {
    const dir = entriesDir(roots, "wolfpack");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "kb-wolfpack-aaa.md"),
      "---\ntitle: Alpha\nsummary: first thing\nsubcategory: core\n---\nbody\n",
    );
    writeFileSync(
      join(dir, "kb-wolfpack-bbb.md"),
      "---\ntitle: Beta\nsummary: second thing\n---\nbody\n",
    );
    renderDomainIndex(roots, "wolfpack");
    const idx = readFileSync(domainIndex(roots, "wolfpack"), "utf-8");
    expect(idx).toContain("2 entries");
    expect(idx).toContain("- [[kb-wolfpack-aaa|Alpha]] _(core)_ — first thing");
    expect(idx).toContain("- [[kb-wolfpack-bbb|Beta]] — second thing");
  });
});

describe("unclassified quarantine path", () => {
  it("quarantine dir is outside any domain folder (never mirrored)", () => {
    const q = unclassifiedDir(roots);
    expect(q).toBe(join(roots.kbBase, "_unclassified"));
    expect(q.includes(`${join("domains")}/`)).toBe(false);
  });
});
