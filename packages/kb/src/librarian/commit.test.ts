import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { commitEntry } from "./commit.js";
import type { KbRoots } from "../shared/index.js";
import {
  type Entry as Entry,
  EntryId,
  DomainId,
  SectionId,
  IsoDate,
} from "../schema/knowledge.js";

describe("commitEntry (section-aware frontmatter)", () => {
  let tmpDir: string;
  let roots: KbRoots;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kb-commit-test-"));
    roots = { kbBase: tmpDir, opsRoot: join(tmpDir, "ops"), denLocal: join(tmpDir, "den") };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes frontmatter with section and placement", () => {
    const entry: Entry = {
      id: EntryId.parse("kb-wolfpack-abc1234"),
      domain: DomainId.parse("wolfpack"),
      title: "Test Entry",
      kind: { type: "architecture" },
      summary: "Test summary",
      detail: "Test detail",
      confidence: "high",
      facets: {},
      section: SectionId.parse("sec-wolfpack-abc123"),
      placement: { basis: "routed", fit: 0.85 },
      relations: [],
      authority: "curated",
      maturity: "active",
      currency: "live",
      verified: false,
      created: IsoDate.parse("2026-01-01"),
      updated: IsoDate.parse("2026-01-02"),
      contentHash: "abc123hash",
    };

    commitEntry(roots, entry);

    const filePath = join(tmpDir, "domains", "wolfpack", "entries", "kb-wolfpack-abc1234.md");
    const content = readFileSync(filePath, "utf-8");

    // Check for frontmatter fields
    expect(content).toContain("section: sec-wolfpack-abc123");
    expect(content).toContain("placement:");
    expect(content).toContain("  basis: routed");
    expect(content).toContain("  fit: 0.850");
  });

  it("writes typed relations array", () => {
    const entry: Entry = {
      id: EntryId.parse("kb-wolfpack-abc1234"),
      domain: DomainId.parse("wolfpack"),
      title: "Test Entry",
      kind: { type: "architecture" },
      summary: "Test summary",
      detail: "Test detail",
      confidence: "high",
      facets: {},
      section: SectionId.parse("sec-wolfpack-abc123"),
      placement: { basis: "routed", fit: 0.85 },
      relations: [
        {
          kind: "refines",
          target: EntryId.parse("kb-wolfpack-target1"),
          source: "llm",
        },
        {
          kind: "depends_on",
          target: EntryId.parse("kb-wolfpack-target2"),
          source: "embedding",
          weight: 0.92,
        },
      ],
      authority: "curated",
      maturity: "active",
      currency: "live",
      verified: false,
      created: IsoDate.parse("2026-01-01"),
      updated: IsoDate.parse("2026-01-02"),
      contentHash: "abc123hash",
    };

    commitEntry(roots, entry);

    const filePath = join(tmpDir, "domains", "wolfpack", "entries", "kb-wolfpack-abc1234.md");
    const content = readFileSync(filePath, "utf-8");

    expect(content).toContain("relations:");
    expect(content).toContain("  - kind: refines");
    expect(content).toContain("    target: kb-wolfpack-target1");
    expect(content).toContain("    source: llm");
    expect(content).toContain("  - kind: depends_on");
    expect(content).toContain("    target: kb-wolfpack-target2");
    expect(content).toContain("    source: embedding");
    expect(content).toContain("    weight: 0.920");
  });

  it("writes discriminated union kind (type=other with tag)", () => {
    const entry: Entry = {
      id: EntryId.parse("kb-wolfpack-abc1234"),
      domain: DomainId.parse("wolfpack"),
      title: "Test Entry",
      kind: { type: "other", tag: "custom-type" as any },
      summary: "Test summary",
      detail: "Test detail",
      confidence: "high",
      facets: {},
      section: SectionId.parse("sec-wolfpack-abc123"),
      placement: { basis: "routed", fit: 0.85 },
      relations: [],
      authority: "curated",
      maturity: "active",
      currency: "live",
      verified: false,
      created: IsoDate.parse("2026-01-01"),
      updated: IsoDate.parse("2026-01-02"),
      contentHash: "abc123hash",
    };

    commitEntry(roots, entry);

    const filePath = join(tmpDir, "domains", "wolfpack", "entries", "kb-wolfpack-abc1234.md");
    const content = readFileSync(filePath, "utf-8");

    expect(content).toContain("kind:");
    expect(content).toContain("  type: other");
    expect(content).toContain("  tag: custom-type");
  });

  it("writes facets when present", () => {
    const entry: Entry = {
      id: EntryId.parse("kb-wolfpack-abc1234"),
      domain: DomainId.parse("wolfpack"),
      title: "Test Entry",
      kind: { type: "architecture" },
      summary: "Test summary",
      detail: "Test detail",
      confidence: "high",
      facets: { subsystem: "auth" as any, layer: "core" as any },
      section: SectionId.parse("sec-wolfpack-abc123"),
      placement: { basis: "routed", fit: 0.85 },
      relations: [],
      authority: "curated",
      maturity: "active",
      currency: "live",
      verified: false,
      created: IsoDate.parse("2026-01-01"),
      updated: IsoDate.parse("2026-01-02"),
      contentHash: "abc123hash",
    };

    commitEntry(roots, entry);

    const filePath = join(tmpDir, "domains", "wolfpack", "entries", "kb-wolfpack-abc1234.md");
    const content = readFileSync(filePath, "utf-8");

    expect(content).toContain("facets:");
    expect(content).toContain("  subsystem: auth");
    expect(content).toContain("  layer: core");
  });

  it("includes contentHash for integrity", () => {
    const entry: Entry = {
      id: EntryId.parse("kb-wolfpack-abc1234"),
      domain: DomainId.parse("wolfpack"),
      title: "Test Entry",
      kind: { type: "architecture" },
      summary: "Test summary",
      detail: "Test detail",
      confidence: "high",
      facets: {},
      section: SectionId.parse("sec-wolfpack-abc123"),
      placement: { basis: "routed", fit: 0.85 },
      relations: [],
      authority: "curated",
      maturity: "active",
      currency: "live",
      verified: false,
      created: IsoDate.parse("2026-01-01"),
      updated: IsoDate.parse("2026-01-02"),
      contentHash: "sha256-abc123def456",
    };

    commitEntry(roots, entry);

    const filePath = join(tmpDir, "domains", "wolfpack", "entries", "kb-wolfpack-abc1234.md");
    const content = readFileSync(filePath, "utf-8");

    expect(content).toContain("contentHash: sha256-abc123def456");
  });
});
