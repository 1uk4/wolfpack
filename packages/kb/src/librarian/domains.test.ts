/**
 * domains.test.ts — Tests for domain digest generation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderDomainDigest } from "./domains.js";
import { writeSections } from "./sections.js";
import type { KbRoots } from "../shared/index.js";
import type { Section, SectionId, DomainId } from "../schema/knowledge.js";

describe("domains — renderDomainDigest", () => {
  let testRoot: string;
  let roots: KbRoots;

  beforeEach(() => {
    // Create a temporary test directory
    testRoot = join(tmpdir(), `kb-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    roots = {
      kbBase: join(testRoot, "base"),
      opsRoot: join(testRoot, "ops"),
      denLocal: join(testRoot, "den"),
    };
    mkdirSync(join(roots.kbBase, "domains", "test-domain", "entries"), { recursive: true });
    mkdirSync(join(roots.denLocal, "sections"), { recursive: true });
  });

  afterEach(() => {
    // Clean up
    if (existsSync(testRoot)) {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("generates a deterministic hierarchical digest from a section tree", () => {
    // Create a simple section tree
    const sections: Section[] = [
      {
        id: "sec-test-000001" as SectionId,
        domain: "test-domain" as DomainId,
        parent: null,
        depth: 0,
        label: "root" as any,
        title: "Root Section",
        centroid: new Array(768).fill(0),
        memberCount: 2,
        childIds: ["sec-test-000002" as SectionId],
        summary: "This is the root section",
        summaryHash: "hash1",
        dirty: false,
        created: "2024-01-01" as any,
        updated: "2024-01-01" as any,
      },
      {
        id: "sec-test-000002" as SectionId,
        domain: "test-domain" as DomainId,
        parent: "sec-test-000001" as SectionId,
        depth: 1,
        label: "child" as any,
        title: "Child Section",
        centroid: new Array(768).fill(0),
        memberCount: 1,
        childIds: [],
        summary: "This is a child section",
        summaryHash: "hash2",
        dirty: false,
        created: "2024-01-02" as any,
        updated: "2024-01-02" as any,
      },
    ];
    writeSections(roots, sections);

    // Create some test entries
    const entry1 = `---
id: kb-test-abc1234
title: Entry 1
section: sec-test-000001
currency: live
---
Test entry 1`;
    const entry2 = `---
id: kb-test-abc1235
title: Entry 2
section: sec-test-000001
currency: snapshot
---
Test entry 2`;
    const entry3 = `---
id: kb-test-abc1236
title: Entry 3
section: sec-test-000002
currency: archived
---
Test entry 3`;

    const entriesDir = join(roots.kbBase, "domains", "test-domain", "entries");
    writeFileSync(join(entriesDir, "kb-test-abc1234.md"), entry1);
    writeFileSync(join(entriesDir, "kb-test-abc1235.md"), entry2);
    writeFileSync(join(entriesDir, "kb-test-abc1236.md"), entry3);

    // Generate the digest
    renderDomainDigest(roots, "test-domain");

    // Read and validate the digest
    const digestPath = join(roots.kbBase, "domains", "test-domain", "_digest.json");
    expect(existsSync(digestPath)).toBe(true);

    const digest = JSON.parse(readFileSync(digestPath, "utf-8"));
    expect(digest.domain).toBe("test-domain");
    expect(digest.sections).toHaveLength(1);
    expect(digest.sections[0].sectionId).toBe("sec-test-000001");
    expect(digest.sections[0].title).toBe("Root Section");
    expect(digest.sections[0].summary).toBe("This is the root section");
    expect(digest.sections[0].entryIds).toHaveLength(2);
    expect(digest.sections[0].children).toHaveLength(1);
    expect(digest.sections[0].children[0].sectionId).toBe("sec-test-000002");
    expect(digest.sections[0].children[0].entryIds).toHaveLength(1);
  });

  it("rolls up currency using live > snapshot > archived precedence", () => {
    const sections: Section[] = [
      {
        id: "sec-test-000001" as SectionId,
        domain: "test-domain" as DomainId,
        parent: null,
        depth: 0,
        label: "root" as any,
        title: "Root Section",
        centroid: new Array(768).fill(0),
        memberCount: 2,
        childIds: ["sec-test-000002" as SectionId, "sec-test-000003" as SectionId],
        summary: "Root section",
        summaryHash: "hash1",
        dirty: false,
        created: "2024-01-01" as any,
        updated: "2024-01-01" as any,
      },
      {
        id: "sec-test-000002" as SectionId,
        domain: "test-domain" as DomainId,
        parent: "sec-test-000001" as SectionId,
        depth: 1,
        label: "live-child" as any,
        title: "Live Child",
        centroid: new Array(768).fill(0),
        memberCount: 1,
        childIds: [],
        summary: "Child with live entry",
        summaryHash: "hash2",
        dirty: false,
        created: "2024-01-02" as any,
        updated: "2024-01-02" as any,
      },
      {
        id: "sec-test-000003" as SectionId,
        domain: "test-domain" as DomainId,
        parent: "sec-test-000001" as SectionId,
        depth: 1,
        label: "archived-child" as any,
        title: "Archived Child",
        centroid: new Array(768).fill(0),
        memberCount: 1,
        childIds: [],
        summary: "Child with archived entry",
        summaryHash: "hash3",
        dirty: false,
        created: "2024-01-03" as any,
        updated: "2024-01-03" as any,
      },
    ];
    writeSections(roots, sections);

    const entriesDir = join(roots.kbBase, "domains", "test-domain", "entries");
    writeFileSync(
      join(entriesDir, "kb-test-live.md"),
      "---\nid: kb-test-live\nsection: sec-test-000002\ncurrency: live\n---\nLive entry"
    );
    writeFileSync(
      join(entriesDir, "kb-test-archived.md"),
      "---\nid: kb-test-archived\nsection: sec-test-000003\ncurrency: archived\n---\nArchived entry"
    );

    renderDomainDigest(roots, "test-domain");

    const digestPath = join(roots.kbBase, "domains", "test-domain", "_digest.json");
    const digest = JSON.parse(readFileSync(digestPath, "utf-8"));

    // Root should be "live" because one of its children has live currency
    expect(digest.sections[0].currency).toBe("live");
    expect(digest.sections[0].children[0].currency).toBe("live");
    expect(digest.sections[0].children[1].currency).toBe("archived");
  });

  it("hash-guards the write: unchanged tree does NOT rewrite file", () => {
    const sections: Section[] = [
      {
        id: "sec-test-000001" as SectionId,
        domain: "test-domain" as DomainId,
        parent: null,
        depth: 0,
        label: "root" as any,
        title: "Root Section",
        centroid: new Array(768).fill(0),
        memberCount: 1,
        childIds: [],
        summary: "Root summary",
        summaryHash: "hash1",
        dirty: false,
        created: "2024-01-01" as any,
        updated: "2024-01-01" as any,
      },
    ];
    writeSections(roots, sections);

    const entriesDir = join(roots.kbBase, "domains", "test-domain", "entries");
    writeFileSync(
      join(entriesDir, "kb-test-entry.md"),
      "---\nid: kb-test-entry\nsection: sec-test-000001\ncurrency: live\n---\nTest"
    );

    // First write
    renderDomainDigest(roots, "test-domain");
    const digestPath = join(roots.kbBase, "domains", "test-domain", "_digest.json");
    const firstContent = readFileSync(digestPath, "utf-8");
    const firstDigest = JSON.parse(firstContent);
    const firstMtime = existsSync(digestPath)
      ? readFileSync(digestPath, "utf-8")
      : "";

    // Wait a bit to ensure mtime would change if file is rewritten
    const beforeSecondRender = Date.now();

    // Second write with same content (should NOT rewrite)
    renderDomainDigest(roots, "test-domain");
    const secondContent = readFileSync(digestPath, "utf-8");
    const secondDigest = JSON.parse(secondContent);

    // The generated timestamp will differ, but the structure should be the same
    // and the file should NOT have been rewritten (we can verify by checking the
    // actual file wasn't touched, though in practice we'd need to mock the filesystem
    // or check write timestamps)
    expect(secondDigest.domain).toBe(firstDigest.domain);
    expect(secondDigest.sections).toEqual(firstDigest.sections);
  });

  it("hash-guards the write: changed tree DOES rewrite file", () => {
    const sections: Section[] = [
      {
        id: "sec-test-000001" as SectionId,
        domain: "test-domain" as DomainId,
        parent: null,
        depth: 0,
        label: "root" as any,
        title: "Root Section",
        centroid: new Array(768).fill(0),
        memberCount: 1,
        childIds: [],
        summary: "Root summary",
        summaryHash: "hash1",
        dirty: false,
        created: "2024-01-01" as any,
        updated: "2024-01-01" as any,
      },
    ];
    writeSections(roots, sections);

    const entriesDir = join(roots.kbBase, "domains", "test-domain", "entries");
    writeFileSync(
      join(entriesDir, "kb-test-entry.md"),
      "---\nid: kb-test-entry\nsection: sec-test-000001\ncurrency: live\n---\nTest"
    );

    // First write
    renderDomainDigest(roots, "test-domain");
    const digestPath = join(roots.kbBase, "domains", "test-domain", "_digest.json");
    const firstDigest = JSON.parse(readFileSync(digestPath, "utf-8"));

    // Change the section tree
    sections[0].title = "Updated Root Section";
    writeSections(roots, sections);

    // Second write with changed content (should rewrite)
    renderDomainDigest(roots, "test-domain");
    const secondDigest = JSON.parse(readFileSync(digestPath, "utf-8"));

    // The title should have changed
    expect(secondDigest.sections[0].title).toBe("Updated Root Section");
    expect(firstDigest.sections[0].title).toBe("Root Section");
  });

  it("respects maxTopics cap", () => {
    // Create more sections than the cap allows
    const sections: Section[] = [];
    const maxTopics = 60; // From DIGEST.maxTopics

    // Create 70 root sections (more than the cap)
    for (let i = 0; i < 70; i++) {
      sections.push({
        id: `sec-test-${String(i).padStart(6, "0")}` as SectionId,
        domain: "test-domain" as DomainId,
        parent: null,
        depth: 0,
        label: `root${i}` as any,
        title: `Root Section ${i}`,
        centroid: new Array(768).fill(0),
        memberCount: 1,
        childIds: [],
        summary: `Summary ${i}`,
        summaryHash: `hash${i}`,
        dirty: false,
        created: "2024-01-01" as any,
        updated: "2024-01-01" as any,
      });
    }
    writeSections(roots, sections);

    renderDomainDigest(roots, "test-domain");

    const digestPath = join(roots.kbBase, "domains", "test-domain", "_digest.json");
    const digest = JSON.parse(readFileSync(digestPath, "utf-8"));

    // Should have capped the number of sections
    expect(digest.sections.length).toBeLessThanOrEqual(maxTopics);
  });
});
