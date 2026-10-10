import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { retireEntries } from "./retire.js";
import { readLedger, appendLedger, foldRegistry } from "./ledger.js";
import { ev, type KbRoots } from "../shared/index.js";

describe("retireEntries", () => {
  let testRoot: string;
  let roots: KbRoots;
  const d = (...p: string[]) => join(roots.kbBase, "domains", "fit", ...p);

  /** One registry topic per canonical id, with the given entries on disk. */
  function seed(topics: Record<string, string[]>): void {
    const events = Object.entries(topics).flatMap(([canonical, entries]) => [
      ...entries.map((e) => ev.entryWritten(e, canonical, "create")),
      ev.aliased("1uk4", `topic-${canonical}`, canonical, "h"),
    ]);
    appendLedger(roots, events);
    for (const e of Object.values(topics).flat()) {
      writeFileSync(d("entries", `${e}.md`), `---\ntitle: ${e}\nsummary: s\n---\nbody`);
    }
  }

  beforeEach(() => {
    testRoot = join(tmpdir(), `kb-retire-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    roots = {
      kbBase: join(testRoot, "base"),
      opsRoot: join(testRoot, "ops"),
      denLocal: join(testRoot, "den"),
    };
    mkdirSync(d("entries"), { recursive: true });
    mkdirSync(join(roots.denLocal, "sections"), { recursive: true });
  });

  afterEach(() => rmSync(testRoot, { recursive: true, force: true }));

  it("deletes the file, records the event, and empties the domain's projections", () => {
    seed({ "kb-fit-aaaaaaa": ["kb-fit-aaaaaaa"] });

    const r = retireEntries(roots, ["kb-fit-aaaaaaa"], { reason: "user deleted" });

    expect(r.retired).toEqual([{ entryId: "kb-fit-aaaaaaa", domain: "fit", hadFile: true }]);
    expect(r.domains).toEqual(["fit"]);
    expect(existsSync(d("entries", "kb-fit-aaaaaaa.md"))).toBe(false);

    const retired = readLedger(roots).filter((e) => e.t === "entry_retired");
    expect(retired).toMatchObject([{ entryId: "kb-fit-aaaaaaa", reason: "user deleted" }]);
    expect(foldRegistry(readLedger(roots)).size).toBe(0);

    // The emptied domain's registry is still rewritten, without the topic.
    const registry = readFileSync(d("_registry.md"), "utf-8");
    expect(registry).toContain("# fit — topic registry");
    expect(registry).not.toContain("kb-fit-aaaaaaa");
    expect(readFileSync(d("INDEX.md"), "utf-8")).toContain("0 entries");
  });

  it("keeps a topic that still has other entries", () => {
    seed({ "kb-fit-aaaaaaa": ["kb-fit-aaaaaaa", "kb-fit-bbbbbbb"] });

    retireEntries(roots, ["kb-fit-bbbbbbb"]);

    const topic = foldRegistry(readLedger(roots)).get("kb-fit-aaaaaaa");
    expect(topic?.entries).toEqual(["kb-fit-aaaaaaa"]);
    expect(topic?.aliases).toHaveLength(1);
    expect(readFileSync(d("_registry.md"), "utf-8")).not.toContain("kb-fit-bbbbbbb");
  });

  it("retires a registry-only entry whose file is already gone", () => {
    seed({ "kb-fit-aaaaaaa": ["kb-fit-aaaaaaa"] });
    rmSync(d("entries", "kb-fit-aaaaaaa.md"));

    const r = retireEntries(roots, ["kb-fit-aaaaaaa"]);

    expect(r.retired).toEqual([{ entryId: "kb-fit-aaaaaaa", domain: "fit", hadFile: false }]);
    expect(foldRegistry(readLedger(roots)).size).toBe(0);
  });

  it("reports unknown ids and writes nothing on dry-run", () => {
    seed({ "kb-fit-aaaaaaa": ["kb-fit-aaaaaaa"] });
    const before = readLedger(roots).length;

    const r = retireEntries(roots, ["kb-fit-aaaaaaa", "kb-fit-zzzzzzz"], { dryRun: true });

    expect(r.retired.map((x) => x.entryId)).toEqual(["kb-fit-aaaaaaa"]);
    expect(r.notFound).toEqual(["kb-fit-zzzzzzz"]);
    expect(readLedger(roots)).toHaveLength(before);
    expect(existsSync(d("entries", "kb-fit-aaaaaaa.md"))).toBe(true);
  });

  it("rejects malformed ids before touching anything", () => {
    seed({ "kb-fit-aaaaaaa": ["kb-fit-aaaaaaa"] });
    expect(() => retireEntries(roots, ["kb-fit-aaaaaaa", "../etc/passwd"])).toThrow(/not entry ids/);
    expect(existsSync(d("entries", "kb-fit-aaaaaaa.md"))).toBe(true);
  });
});
