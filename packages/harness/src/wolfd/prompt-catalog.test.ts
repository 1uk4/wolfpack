/** The read-only prompt catalog: registry integrity, the source-scan guard, and the real pi-durable compaction text. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readOnlyCatalog } from "./prompt-catalog.js";

const blocks = [{ id: "header", label: "Header", source: "context.ts", text: "You are w." }];
const tools = [{ name: "show_graph", description: "Show a graph.", extension: "wolfpack-objects" }];
const catalog = () => readOnlyCatalog({ blocks, tools });

describe("read-only prompt catalog", () => {
  it("every id is unique, has a non-empty default and declares exactly the {{placeholders}} its text uses", () => {
    const all = catalog();
    expect(new Set(all.map((e) => e.id)).size).toBe(all.length);
    for (const e of all) {
      expect(e.text.trim().length, e.id).toBeGreaterThan(0);
      const used = [...new Set([...e.text.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)].map((m) => m[1]))].sort();
      expect([...e.placeholders].sort(), e.id).toEqual(used);
      expect(e.user, e.id).not.toBe("");
      expect(e.file, e.id).not.toBe("");
    }
  });

  it("serves the wolf's blocks and tool descriptions as given, tagged system-block and tool", () => {
    const all = catalog();
    expect(all.find((e) => e.id === "system.header")).toMatchObject({ kind: "system-block", text: "You are w.", file: "context.ts", scope: "wolf" });
    expect(all.find((e) => e.id === "tool.show_graph")).toMatchObject({ kind: "tool", text: "Show a graph." });
  });

  it("pipeline prompts carry their locked output contract; the observer's is an object with observations", () => {
    const obs = catalog().find((e) => e.id === "pipeline.observer");
    expect(obs?.kind).toBe("pipeline");
    const c = JSON.parse(obs!.contract!);
    expect(c.type).toBe("object");
    expect(Object.keys(c.properties)).toContain("observations");
  });

  it("returns the real pi-durable compaction text, read from the installed package", () => {
    const all = catalog();
    expect(all.find((e) => e.id === "compaction.pi-durable-system")?.text).toMatch(/^You are a context summarization assistant\./);
    expect(all.find((e) => e.id === "compaction.pi-durable-instructions")?.text).toContain("Use this EXACT format:");
    expect(all.find((e) => e.id === "compaction.pi-durable-system")?.file).toMatch(/^@earendil-works\/pi-durable@\d+\.\d+\.\d+ dist\/harness\/compaction\.js SUMMARIZATION_SYSTEM_PROMPT$/);
  });

  it("source scan: every *_SYSTEM constant the memory and harness sources use is registered here or is a hub sweep prompt", () => {
    const root = join(__dirname, "..", "..", "..");
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => {
        const p = join(d, n);
        if (n === "node_modules" || n === "dist") return [];
        return statSync(p).isDirectory() ? walk(p) : /\.ts$/.test(n) && !/\.test\.ts$/.test(n) ? [p] : [];
      });
    const found = new Set<string>();
    for (const pkg of ["memory", "harness"]) {
      for (const f of walk(join(root, pkg, "src"))) {
        for (const m of readFileSync(f, "utf8").matchAll(/\b([A-Z][A-Z_]*_SYSTEM|DISTILL_GRADUATION(?:_STANDING)?)\b/g)) found.add(m[1]!);
      }
    }
    const hub = new Set([...readFileSync(join(root, "hubd", "src", "settings.ts"), "utf8").matchAll(/\b([A-Z][A-Z_]*_SYSTEM)\b/g)].map((m) => m[1]!));
    const registered = new Set(catalog().flatMap((e) => e.constants ?? []));
    const missing = [...found].filter((c) => !registered.has(c) && !hub.has(c));
    expect(missing).toEqual([]);
    expect(found.size).toBeGreaterThan(5);
  });
});
