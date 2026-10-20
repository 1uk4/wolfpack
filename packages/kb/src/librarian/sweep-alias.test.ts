import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import { sweep } from "./sweep.js";
import { readLedger, appendLedger, foldRegistry } from "./ledger.js";
import { ev } from "../shared/index.js";
import type { KbRoots } from "../shared/index.js";

describe("sweep: missing alias target creates fresh entry", () => {
  let base: string;
  let roots: KbRoots;
  const notes: string[] = [];
  const inbox = () => join(roots.opsRoot, "inbox", "w1");
  const entries = () => join(roots.kbBase, "domains", "wp", "entries");
  const receipts = () => join(roots.opsRoot, "receipts", "w1");

  const engine = {
    call: vi.fn(async (step: string, schema: { parse: (v: unknown) => unknown }) => {
      if (step === "classifyToSection") {
        return schema.parse({ section: "NEW", confidence: "low" });
      }
      return schema.parse({
        title: "Memory topic",
        kind: { type: "fact" },
        summary: "A den memory topic",
        detail: "Some detail about this topic",
        confidence: "high",
        facets: {},
        properties: {},
        proposedRelations: [],
      });
    }),
    usage: { summarize: () => ({}) },
  } as unknown as Engine;

  beforeEach(() => {
    notes.length = 0;
    base = mkdtempSync(join(tmpdir(), "kb-alias-"));
    roots = {
      kbBase: join(base, "base"),
      opsRoot: join(base, "ops"),
      denLocal: join(base, "den"),
    };
    mkdirSync(inbox(), { recursive: true });
    mkdirSync(entries(), { recursive: true });
    mkdirSync(join(roots.opsRoot, "ledger"), { recursive: true });

    // Stub embedding to return a simple vector
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ embedding: [0.5, 0.5, 0.0] })))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(base, { recursive: true, force: true });
  });

  const drop = (topic: string, hash: string, body: string) =>
    writeFileSync(
      join(inbox(), `${topic}-${hash}.md`),
      [
        "---",
        "from: w1",
        `den_topic_id: ${topic}`,
        "change: create",
        `content_hash: ${hash}`,
        "prev_hash: null",
        "domain_hint: wp",
        "submitted: 2026-10-10T01:00:00Z",
        "---",
        "",
        `# ${topic}`,
        "",
        body,
        "",
      ].join("\n")
    );

  const run = (vectors: Array<{ entryId: string; domain: string; vector: number[] }> = []) =>
    sweep({
      engine,
      roots,
      notify: (m) => notes.push(m),
      loadEntryVectors: async () => vectors as any,
    });

  it("creates a fresh entry when the aliased target entry is missing from disk", async () => {
    // Step 1: Create an initial entry on disk and seed ledger events that establish an alias
    const initialEntryId = "kb-wp-ALIASED1";
    const initialContent = [
      "---",
      `id: ${initialEntryId}`,
      "section: sec-wp-aaaaaa",
      "title: Original Topic",
      "---",
      "",
      "This is the original entry content.",
      "",
    ].join("\n");
    writeFileSync(join(entries(), `${initialEntryId}.md`), initialContent);

    // Seed the ledger with initial events that establish the alias
    appendLedger(roots, [
      ev.contribution({
        from: "w1",
        denTopicId: "t1",
        hash: "hash-initial-abc123",
        prevHash: null,
        domainHint: "wp",
      }),
      ev.entryWritten(initialEntryId, initialEntryId, "create"),
      ev.aliased("w1", "t1", initialEntryId, "hash-initial-abc123"),
    ]);

    // Verify the alias is established
    const regBefore = foldRegistry(readLedger(roots));
    const topicBefore = Array.from(regBefore.values()).find((t) =>
      t.aliases.some((a) => a.wolf === "w1" && a.denTopicId === "t1")
    );
    expect(topicBefore).toBeDefined();
    expect(topicBefore!.entries[0]).toBe(initialEntryId);

    // Step 2: Delete the entry file (simulate retire/split)
    unlinkSync(join(entries(), `${initialEntryId}.md`));
    expect(existsSync(join(entries(), `${initialEntryId}.md`))).toBe(false);

    // Step 3: Drop a new contribution from w1/t1
    drop("t1", "hash-new-xyz789", "Updated content for this memory topic");

    // Step 4: Run sweep
    const result = await run([]);

    // Step 5: Assert the sweep succeeded
    expect(result.errors).toBe(0);
    expect(result.failures).toHaveLength(0);
    expect(result.parked).toHaveLength(0);
    expect(result.created).toBe(1);
    expect(result.merged).toBe(0);

    // Step 6: Assert a new entry was created (with a different ID)
    const entryFiles = require("fs").readdirSync(entries());
    expect(entryFiles).toHaveLength(1);
    const newEntryFile = entryFiles[0];
    expect(newEntryFile).not.toBe(`${initialEntryId}.md`);

    const newEntryId = newEntryFile.replace(".md", "");
    const newEntryContent = readFileSync(join(entries(), newEntryFile), "utf-8");
    // Entry content is LLM-generated, so just verify it's a valid entry
    expect(newEntryContent).toContain(`id: ${newEntryId}`);
    expect(newEntryContent).toContain("title:");
    expect(newEntryContent).toContain("domain: wp");

    // Step 7: Assert receipt points to the new entry
    const receiptFiles = require("fs").readdirSync(receipts());
    expect(receiptFiles.length).toBeGreaterThan(0);
    const receiptContent = readFileSync(join(receipts(), receiptFiles[0]), "utf-8");
    expect(receiptContent).toContain("outcome: create");
    expect(receiptContent).toContain(newEntryId);

    // Step 8: Assert the alias was re-pointed to the new entry
    const regAfter = foldRegistry(readLedger(roots));
    // Find the topic with the new entry ID
    const newTopic = regAfter.get(newEntryId);
    expect(newTopic).toBeDefined();
    // The new topic should have the alias
    const aliasInNewTopic = newTopic!.aliases.find(
      (a) => a.wolf === "w1" && a.denTopicId === "t1"
    );
    expect(aliasInNewTopic).toBeDefined();
    expect(aliasInNewTopic!.lastHash).toBe("hash-new-xyz789");

    // Verify the new aliased event was recorded
    const ledger = readLedger(roots);
    const aliasedEvents = ledger.filter((e) => e.t === "aliased");
    expect(aliasedEvents).toHaveLength(2); // initial + new
    const latestAlias = aliasedEvents[aliasedEvents.length - 1];
    expect(latestAlias).toMatchObject({
      t: "aliased",
      wolf: "w1",
      denTopicId: "t1",
      canonicalId: newEntryId,
      hash: "hash-new-xyz789",
    });
  });

  it("works correctly when alias target exists on disk (baseline)", async () => {
    // This test verifies the normal case: alias target exists and gets updated

    const existingEntryId = "kb-wp-EXISTS1";
    const initialContent = [
      "---",
      `id: ${existingEntryId}`,
      "section: sec-wp-bbbbbb",
      "title: Existing Topic",
      "---",
      "",
      "Original content.",
      "",
    ].join("\n");
    writeFileSync(join(entries(), `${existingEntryId}.md`), initialContent);

    // Establish alias
    appendLedger(roots, [
      ev.contribution({
        from: "w1",
        denTopicId: "t2",
        hash: "hash-orig-def456",
        prevHash: null,
        domainHint: "wp",
      }),
      ev.entryWritten(existingEntryId, existingEntryId, "create"),
      ev.aliased("w1", "t2", existingEntryId, "hash-orig-def456"),
    ]);

    // Drop new contribution from same wolf/topic
    drop("t2", "hash-update-uvw321", "Updated content for existing entry");

    // Run sweep with the existing entry in vectors
    const result = await run([
      { entryId: existingEntryId, domain: "wp", vector: [0.5, 0.5, 0.0] },
    ]);

    // Should merge into existing entry
    expect(result.errors).toBe(0);
    expect(result.created).toBe(0);
    expect(result.merged).toBe(1);

    // Entry file should still be the same ID
    const entryFiles = require("fs").readdirSync(entries());
    expect(entryFiles).toContain(`${existingEntryId}.md`);

    // Verify receipt shows merge
    const receiptFiles = require("fs").readdirSync(receipts());
    const receiptContent = readFileSync(join(receipts(), receiptFiles[0]), "utf-8");
    expect(receiptContent).toContain("outcome: merge");
    expect(receiptContent).toContain(existingEntryId);
  });
});
