/**
 * End to end: the wolf's graduation files → Dewey's real sweep (fake model).
 * Feature 1 creates its entry and the initiative hub; feature 2 updates the
 * hub; completing the initiative writes the final hub. Nothing links back to
 * work items.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import type { WorkItem } from "@wolfpack/kb/client";
import { sweep } from "@wolfpack/kb/librarian";
import { graduationFiles } from "./graduate.js";

let n = 0;
const w = (kind: string, title: string, partOf: string | null, extra: Partial<WorkItem> = {}) =>
  ({
    id: `work-wp-${kind.slice(0, 3)}${String(++n).padStart(4, "0")}`,
    kind, title, partOf, domain: "wp", stage: "shipped", successCriteria: `${title} works`,
    log: [], dependsOn: [], graduated: null, container: false, ...extra,
  }) as unknown as WorkItem;

describe("graduationFiles", () => {
  const init = w("initiative", "Dockerize", null, { stage: "in_build" });
  const f1 = w("feature", "Base image", init.id, { graduated: "2026-10-01" } as any);
  const f2 = w("feature", "Compose", init.id);
  const f3 = w("feature", "CLI plane", init.id, { stage: "plan" });
  const t = w("task", "Write Dockerfile", f2.id, { log: [{ at: "x", text: "added Dockerfile" }] } as any);
  const solo = w("feature", "Standalone", null);
  const all = [init, f1, f2, f3, t, solo];
  const files = (item: WorkItem) => graduationFiles({ item, all, bodyOf: () => "", from: "1uk4", now: new Date(1000) });

  it("a feature under an initiative sends its entry, then the hub listing delivered features only", () => {
    const [feat, hub] = files(f2);
    expect(feat.content).toMatch(/graduation: feature\nentry_id: kb-wp-/);
    expect(feat.content).toContain("added Dockerfile");
    expect(hub.content).toMatch(new RegExp(`graduation: hub\\nentry_id: kb-wp-${init.id.split("-").pop()}`));
    expect(hub.content).toContain(`[[kb-wp-${f1.id.split("-").pop()}]] Base image`);
    expect(hub.content).toContain(`[[kb-wp-${f2.id.split("-").pop()}]] Compose`);
    expect(hub.content).not.toContain("CLI plane"); // not delivered
    expect(hub.content).not.toContain("final: true");
    expect(hub.name > feat.name).toBe(true); // sent after the feature
  });

  it("a standalone feature sends only its entry; an initiative sends its final hub", () => {
    expect(files(solo)).toHaveLength(1);
    const [hub] = files(init);
    expect(hub.content).toContain("final: true");
  });
});

describe("graduation flow through the real sweep", () => {
  let base: string;
  const roots = () => ({ kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") });
  const calls: Array<{ system: string; prompt: string }> = [];
  const engine = {
    call: vi.fn(async (step: string, schema: { parse: (v: unknown) => unknown }, opts: { system: string; prompt: string }) => {
      if (step === "classifyToSection") return schema.parse({ section: "NEW", confidence: "low" });
      calls.push(opts);
      const hub = opts.system.includes("INITIATIVE HUB");
      const title = hub ? "Dockerize hub" : (opts.prompt.match(/^# (.+)$/m)?.[1] ?? "Feature");
      return schema.parse({
        title, kind: { type: "architecture" }, summary: `${title} summary`, detail: "d",
        confidence: "high", facets: {}, properties: {}, proposedRelations: [],
      });
    }),
    usage: { summarize: () => ({}) },
  } as unknown as Engine;

  beforeEach(() => {
    calls.length = 0;
    base = mkdtempSync(join(tmpdir(), "grad-flow-"));
    mkdirSync(join(base, "ops", "inbox", "1uk4"), { recursive: true });
    mkdirSync(join(base, "base", "domains", "wp", "entries"), { recursive: true });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ embedding: [1, 0, 0] }))));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(base, { recursive: true, force: true });
  });

  const graduate = async (item: WorkItem, all: WorkItem[]) => {
    for (const f of graduationFiles({ item, all, bodyOf: () => "", from: "1uk4", now: new Date() })) {
      writeFileSync(join(base, "ops", "inbox", "1uk4", f.name), f.content);
    }
    return sweep({ engine, roots: roots(), loadEntryVectors: async () => [], notify: () => {} });
  };
  const entry = (id: string) => join(base, "base", "domains", "wp", "entries", `kb-wp-${id.split("-").pop()}.md`);
  const sectionOf = (file: string) => readFileSync(file, "utf8").match(/^section: (.+)$/m)?.[1];

  it("creates the hub with the first feature, updates it with the next, then completes it", async () => {
    const init = w("initiative", "Dockerize", null, { stage: "in_build" });
    const f1 = w("feature", "Base image", init.id);
    const f2 = w("feature", "Compose", init.id);

    // 1 · first feature: its entry, then the hub in the same section
    expect(await graduate(f1, [init, f1, f2])).toMatchObject({ created: 2, merged: 0 });
    expect(existsSync(entry(f1.id)) && existsSync(entry(init.id))).toBe(true);
    expect(sectionOf(entry(init.id))).toBe(sectionOf(entry(f1.id)));
    const hub1 = calls[1];
    expect(hub1.system).toContain("GRADUATION — INITIATIVE HUB ENTRY");
    expect(hub1.prompt).toContain("RECORDED FEATURE ENTRIES");
    expect(hub1.prompt).toContain("Base image summary");
    expect(hub1.prompt).not.toContain("Compose");
    expect(readFileSync(entry(init.id), "utf8")).toMatch(/^kind: overview$/m);

    // 2 · second feature: hub regenerated (updated in place), listing both
    calls.length = 0;
    const f1g = { ...f1, graduated: "2026-10-10" } as WorkItem;
    expect(await graduate(f2, [init, f1g, f2])).toMatchObject({ created: 1, merged: 1 });
    expect(calls[1].prompt).toContain("Base image");
    expect(calls[1].prompt).toContain("Compose");
    expect(calls[1].prompt).not.toContain("EXISTING ENTRY");
    expect(calls[1].prompt).not.toContain("THE INITIATIVE IS COMPLETE");

    // 3 · completing the initiative: final hub
    calls.length = 0;
    const f2g = { ...f2, graduated: "2026-10-10" } as WorkItem;
    expect(await graduate(init, [init, f1g, f2g])).toMatchObject({ created: 0, merged: 1 });
    expect(calls[0].prompt).toContain("THE INITIATIVE IS COMPLETE");

    // Nothing in the KB names a work item.
    for (const id of [f1.id, f2.id, init.id]) expect(readFileSync(entry(id), "utf8")).not.toMatch(/work-wp-/);
  });
});
