import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "@wolfpack/engine";
import { scanFat, splitFatEntry, splitFatAuto, SPLIT_FAT } from "./split-fat.js";
import type { KbRoots } from "../shared/index.js";
import { readLedger, foldRegistry } from "./ledger.js";
import { ledgeredByDomain, driftOf } from "./drift.js";

let tmp: string;
let roots: KbRoots;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "split-fat-"));
  roots = {
    kbBase: join(tmp, "kb"),
    opsRoot: join(tmp, "ops"),
    denLocal: join(tmp, "den"),
  };
  mkdirSync(join(roots.kbBase, "domains", "testdom", "entries"), { recursive: true });
  mkdirSync(join(roots.denLocal, "ledger"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeEntry(domain: string, id: string, size: number): string {
  const path = join(roots.kbBase, "domains", domain, "entries", `${id}.md`);
  const section1 = "## Section A\n\n" + "a".repeat(Math.floor(size / 2));
  const section2 = "\n\n## Section B\n\n" + "b".repeat(Math.max(100, size - section1.length - 500));
  const fm = [
    "---",
    `id: ${id}`,
    `title: "Fat Entry ${id}"`,
    `domain: ${domain}`,
    `section: sec-${domain}-abc123`,
    `placement:`,
    `  basis: routed`,
    `  fit: 0.800`,
    `kind: overview`,
    `maturity: stub`,
    `authority: curated`,
    `confidence: high`,
    `currency: live`,
    `facets:`,
    `  subsystem: xyz`,
    `properties:`,
    `  foo: "bar"`,
    `created: 2026-01-01`,
    `updated: 2026-01-02`,
    `contentHash: sha256:abc`,
    `---`,
    "",
    section1,
    section2,
  ].join("\n");
  writeFileSync(path, fm);
  return path;
}

describe("scanFat", () => {
  it("skips anchored entries", () => {
    const p = writeEntry("testdom", "kb-testdom-anchor1", 30000);
    writeFileSync(p, readFileSync(p, "utf-8").replace("id: kb-testdom-anchor1\n", "id: kb-testdom-anchor1\nanchor: work-testdom-FEAT001\n"));
    writeEntry("testdom", "kb-testdom-plain01", 30000);
    expect(scanFat(roots, { domain: "testdom" }).map((c) => c.entryId)).toEqual(["kb-testdom-plain01"]);
  });

  it("returns oversized entries sorted largest-first", () => {
    writeEntry("testdom", "kb-testdom-small01", 500);
    writeEntry("testdom", "kb-testdom-medium1", 15000);
    writeEntry("testdom", "kb-testdom-biggest", 30000);

    const out = scanFat(roots, { domain: "testdom" });

    expect(out.map((c) => c.entryId)).toEqual([
      "kb-testdom-biggest",
      "kb-testdom-medium1",
    ]);
    expect(out[0].size).toBeGreaterThan(out[1].size);
    expect(out[0].domain).toBe("testdom");
    expect(out[0].nH2Sections).toBeGreaterThanOrEqual(2);
    expect(out[0].suggestedShards).toBeGreaterThanOrEqual(3);
  });

  it("respects a custom threshold", () => {
    writeEntry("testdom", "kb-testdom-tinyone", 2000);
    writeEntry("testdom", "kb-testdom-mediuma", 5000);

    const low = scanFat(roots, { domain: "testdom", threshold: 1500 });
    const high = scanFat(roots, { domain: "testdom", threshold: 10000 });

    expect(low.length).toBe(2);
    expect(high.length).toBe(0);
  });

  it("scans every domain when none is specified", () => {
    mkdirSync(join(roots.kbBase, "domains", "other", "entries"), { recursive: true });
    writeEntry("testdom", "kb-testdom-aaaaaa1", 12000);
    writeEntry("other", "kb-other-bbbbbb2", 15000);

    const out = scanFat(roots);
    expect(out.map((c) => c.domain).sort()).toEqual(["other", "testdom"]);
  });
});

describe("splitFatEntry", () => {
  function fakeEngine(shards: Array<{ title: string; summary: string; body: string }>): Engine {
    return {
      call: async (_step: string, schema: { parse: (v: unknown) => unknown }) => {
        return schema.parse({ shards });
      },
      usage: { summarize: () => ({ totalInputTokens: 0, totalOutputTokens: 0, callCount: 0 }) },
    } as unknown as Engine;
  }

  it("writes shards, injects see_also relations, and retires the parent", async () => {
    writeEntry("testdom", "kb-testdom-parent1", 18000);
    const engine = fakeEngine([
      { title: "Shard One", summary: "First half", body: "## Section A\n\n" + "x".repeat(500) },
      { title: "Shard Two", summary: "Second half", body: "## Section B\n\n" + "y".repeat(500) },
    ]);

    const r = await splitFatEntry({
      engine,
      roots,
      entryId: "kb-testdom-parent1",
    });

    expect(r.retired).toBe(true);
    expect(r.shards.length).toBe(2);

    // Shards are first-class ledger members; the parent is retired.
    const events = readLedger(roots) as Array<Record<string, unknown>>;
    for (const s of r.shards) {
      expect(events).toContainEqual(expect.objectContaining({ t: "entry_written", entryId: s.entryId, canonicalId: s.entryId, action: "create" }));
      expect(events).toContainEqual(expect.objectContaining({ t: "entry_placed", entryId: s.entryId, sectionId: "sec-testdom-abc123" }));
    }
    expect(events).toContainEqual(expect.objectContaining({ t: "entry_retired", entryId: "kb-testdom-parent1" }));
    const members = [...foldRegistry(readLedger(roots)).values()].flatMap((t) => t.entries);
    expect(members.sort()).toEqual(r.shards.map((s) => s.entryId).sort());

    // Drift: 0 orphans and 0 missing after the split.
    const onDisk = readdirSync(join(roots.kbBase, "domains", "testdom", "entries")).map((f) => f.slice(0, -3));
    const led = ledgeredByDomain(readLedger(roots) as Array<Record<string, unknown>>).get("testdom") ?? new Set<string>();
    expect(driftOf(onDisk, led)).toEqual({ orphans: [], missing: [] });

    const parentPath = join(roots.kbBase, "domains", "testdom", "entries", "kb-testdom-parent1.md");
    expect(existsSync(parentPath)).toBe(false);

    for (const s of r.shards) {
      const sPath = join(roots.kbBase, "domains", "testdom", "entries", `${s.entryId}.md`);
      const raw = readFileSync(sPath, "utf-8");
      expect(raw).toContain(`id: ${s.entryId}`);
      expect(raw).toContain(`title: "${s.title}"`);
      expect(raw).toContain("relations:");
      expect(raw).toContain("kind: see_also");
      expect(raw).not.toContain("section: sec-testdom-abc123");
      expect(raw).not.toContain("placement:");
      expect(raw).not.toContain("properties:");
      // Core domain + kind + maturity fields are preserved
      expect(raw).toContain("domain: testdom");
      expect(raw).toContain("kind: overview");
      const other = r.shards.find((o) => o.entryId !== s.entryId)!;
      expect(raw).toContain(`target: ${other.entryId}`);
    }
  });

  it("hand-carries the parent's source-* properties to every shard (and no other property)", async () => {
    const path = writeEntry("testdom", "kb-testdom-parent2", 18000);
    writeFileSync(path, readFileSync(path, "utf-8").replace('  foo: "bar"\n', '  foo: "bar"\n  source-feature: "work-t-FEAT001"\n  source-record-lines: "a1b2c3d4, 0a0b0c0d"\n'));
    const engine = fakeEngine([
      { title: "Shard One", summary: "First half", body: "## Section A\n\n" + "x".repeat(500) },
      { title: "Shard Two", summary: "Second half", body: "## Section B\n\n" + "y".repeat(500) },
    ]);
    const r = await splitFatEntry({ engine, roots, entryId: "kb-testdom-parent2" });
    expect(r.shards).toHaveLength(2);
    for (const sh of r.shards) {
      const raw = readFileSync(join(roots.kbBase, "domains", "testdom", "entries", `${sh.entryId}.md`), "utf-8");
      expect(raw).toContain('properties:\n  source-feature: "work-t-FEAT001"\n  source-record-lines: "a1b2c3d4, 0a0b0c0d"');
      expect(raw).not.toContain("foo:");
    }
  });

  it("dryRun reports shards without touching disk", async () => {
    writeEntry("testdom", "kb-testdom-parent2", 18000);
    const engine = fakeEngine([
      { title: "A", summary: "a", body: "x".repeat(500) },
      { title: "B", summary: "b", body: "y".repeat(500) },
    ]);

    const r = await splitFatEntry({
      engine,
      roots,
      entryId: "kb-testdom-parent2",
      dryRun: true,
    });

    expect(r.retired).toBe(false);
    expect(r.shards.length).toBe(2);
    const parentPath = join(roots.kbBase, "domains", "testdom", "entries", "kb-testdom-parent2.md");
    expect(existsSync(parentPath)).toBe(true);
    for (const s of r.shards) {
      const sPath = join(roots.kbBase, "domains", "testdom", "entries", `${s.entryId}.md`);
      expect(existsSync(sPath)).toBe(false);
    }
  });

  it("skips entries below the threshold", async () => {
    writeEntry("testdom", "kb-testdom-tiny001", 2000);
    const engine = fakeEngine([
      { title: "A", summary: "a", body: "x" },
      { title: "B", summary: "b", body: "y" },
    ]);

    const r = await splitFatEntry({
      engine,
      roots,
      entryId: "kb-testdom-tiny001",
    });

    expect(r.shards).toEqual([]);
    expect(r.retired).toBe(false);
  });
});

describe("splitFatAuto progress reporting", () => {
  function fakeEngine(shards: Array<{ title: string; summary: string; body: string }>) {
    return {
      call: async (_step: string, schema: { parse: (v: unknown) => unknown }) => schema.parse({ shards }),
      usage: { summarize: () => ({ totalInputTokens: 0, totalOutputTokens: 0, callCount: 0 }) },
    } as unknown as Engine;
  }

  it("emits a plan line and per-entry start/done with running remaining count", async () => {
    writeEntry("testdom", "kb-testdom-first111", 15000);
    writeEntry("testdom", "kb-testdom-second22", 12000);
    const engine = fakeEngine([
      { title: "A", summary: "a", body: "x".repeat(500) },
      { title: "B", summary: "b", body: "y".repeat(500) },
    ]);
    const msgs: string[] = [];
    const result = await splitFatAuto({
      engine,
      roots,
      domain: "testdom",
      dryRun: true,
      notify: (m) => msgs.push(m),
    });

    expect(result.processed.length).toBe(2);
    expect(msgs.some((m) => /plan.*2 entries/.test(m))).toBe(true);
    expect(msgs.some((m) => /\[1\/2\] starting/.test(m))).toBe(true);
    expect(msgs.some((m) => /\[1\/2\] done.*remaining 1/.test(m))).toBe(true);
    expect(msgs.some((m) => /\[2\/2\] done.*remaining 0/.test(m))).toBe(true);
    expect(msgs.some((m) => /complete.*2 parent/.test(m))).toBe(true);
  });

  it("reports a no-op when nothing is oversized", async () => {
    writeEntry("testdom", "kb-testdom-smallq01", 500);
    const msgs: string[] = [];
    const result = await splitFatAuto({
      engine: fakeEngine([]),
      roots,
      domain: "testdom",
      notify: (m) => msgs.push(m),
    });
    expect(result.processed).toEqual([]);
    expect(msgs.some((m) => /no oversized entries/.test(m))).toBe(true);
  });
});

describe("SPLIT_FAT constants", () => {
  it("has sensible defaults", () => {
    expect(SPLIT_FAT.oversizedThreshold).toBe(10_000);
    expect(SPLIT_FAT.targetShardMax).toBeLessThan(SPLIT_FAT.oversizedThreshold);
    expect(SPLIT_FAT.maxShards).toBeGreaterThan(2);
  });
});
