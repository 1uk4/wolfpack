import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KbRoots } from "../shared/index.js";
import { entriesDir, domainIndex, domainFeedDir, unclassifiedDir } from "../shared/index.js";
import { readDeclaredDomains, isDeclared, renderDomainIndex } from "./domains.js";
import { emitFeed } from "./feed.js";
import { drainFeed } from "../client/drainFeed.js";

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
    expect(idx).toContain("**Alpha** _(core)_ — first thing `[kb-wolfpack-aaa]`");
    expect(idx).toContain("**Beta** — second thing `[kb-wolfpack-bbb]`");
  });
});

describe("per-domain feed round-trip (fan-out via mirror)", () => {
  it("emits into the domain folder and drains once, access-scoped", () => {
    emitFeed(roots, "wolfpack", {
      canonicalId: "topic-1",
      entryId: "kb-wolfpack-aaa",
      yourAlias: null,
      change: "created",
      by: "hal",
      summary: "a new thing",
      updated: "2026-10-06 10:00",
    });
    // Notice lives INSIDE the domain folder (mirrors only to subscribers).
    expect(existsSync(join(domainFeedDir(roots, "wolfpack"), "kb-wolfpack-aaa.md"))).toBe(true);

    const first = drainFeed(roots);
    expect(first).toHaveLength(1);
    expect(first[0]!.by).toBe("hal");
    expect(first[0]!.entryId).toBe("kb-wolfpack-aaa");

    // Seen is tracked locally (receiveonly mirror can't delete) → not resurfaced.
    expect(drainFeed(roots)).toHaveLength(0);
  });

  it("resurfaces when the same entry is updated (new timestamp)", () => {
    const base = {
      canonicalId: "topic-1",
      entryId: "kb-wolfpack-aaa",
      yourAlias: null,
      by: "hal",
      summary: "x",
    };
    emitFeed(roots, "wolfpack", { ...base, change: "created", updated: "2026-10-06 10:00" });
    expect(drainFeed(roots)).toHaveLength(1);
    // update overwrites the same notice file with a newer timestamp
    emitFeed(roots, "wolfpack", { ...base, change: "updated", updated: "2026-10-06 12:00" });
    const again = drainFeed(roots);
    expect(again).toHaveLength(1);
    expect(again[0]!.change).toBe("updated");
  });

  it("only drains domains the wolf has (access scoping)", () => {
    // wolf has wolfpack but NOT personal (no folder present)
    emitFeed(roots, "wolfpack", {
      canonicalId: "t", entryId: "e1", yourAlias: null, change: "created",
      by: "a", summary: "s", updated: "t1",
    });
    // simulate a personal notice that never mirrored to this wolf: absent folder
    expect(existsSync(domainFeedDir(roots, "personal"))).toBe(false);
    expect(drainFeed(roots).map((n) => n.entryId)).toEqual(["e1"]);
  });
});

describe("unclassified quarantine path", () => {
  it("quarantine dir is outside any domain folder (never mirrored)", () => {
    const q = unclassifiedDir(roots);
    expect(q).toBe(join(roots.kbBase, "_unclassified"));
    expect(q.includes(`${join("domains")}/`)).toBe(false);
  });
});
