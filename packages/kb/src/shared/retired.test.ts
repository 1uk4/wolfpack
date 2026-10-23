import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveRetiredIds, retiredInto, entryIdDomain, type KbRoots } from "./index.js";
import { mapDeliveredLinks } from "./workLinks.js";

describe("resolveRetiredIds (what a wolf can know: the mirror)", () => {
  let base: string;
  let roots: KbRoots;
  const dom = (...p: string[]) => join(base, "domains", "wp", ...p);
  const live = (id: string) => writeFileSync(dom("entries", `${id}.md`), `---\nid: ${id}\n---\nbody`);
  const retired = (id: string, front = "") => {
    mkdirSync(dom("versions", id), { recursive: true });
    writeFileSync(dom("versions", id, "2026-10-23T17-39-14.001Z-retired.md"), `---\n${front}id: ${id}\n---\nold`);
  };
  const registry = (topics: Record<string, { entries: string[]; aliases: string[] }>) =>
    writeFileSync(
      dom("_registry.md"),
      Object.entries(topics).map(([id, t]) => `## ${id}\n\n- domain: —\n- entries: ${t.entries.join(", ")}\n- subscribers: 1uk4\n- aliases:\n${t.aliases.map((a) => `  - 1uk4:${a} (2026-10-23 01:24)`).join("\n")}\n`).join("\n"),
    );

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "kb-retired-"));
    roots = { kbBase: base, opsRoot: join(base, "ops"), denLocal: join(base, "den") };
    mkdirSync(dom("entries"), { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("reads the domain and the survivor a retired copy records", () => {
    expect(entryIdDomain("kb-wolfpack-T4pp4qR")).toBe("wolfpack");
    expect(retiredInto('---\nretired: "merged into kb-wp-Surv123"\nretiredInto: kb-wp-Surv123\nid: x\n---\n')).toBe("kb-wp-Surv123");
    expect(retiredInto("---\nid: x\n---\n")).toBeUndefined();
  });

  it("keeps live ids, follows a recorded retire chain, drops a retired id with no survivor, dedupes", () => {
    live("kb-wp-Live111");
    live("kb-wp-Surv333");
    retired("kb-wp-Old2222", "retiredInto: kb-wp-Mid2222\n");
    retired("kb-wp-Mid2222", "retiredInto: kb-wp-Surv333\n");
    retired("kb-wp-Gone444");
    expect(resolveRetiredIds(roots, ["kb-wp-Live111", "kb-wp-Old2222", "kb-wp-Gone444", "kb-wp-Surv333"])).toEqual(["kb-wp-Live111", "kb-wp-Surv333"]);
  });

  it("keeps an id the mirror knows nothing about (it may not have synced yet)", () => {
    expect(resolveRetiredIds(roots, ["kb-wp-New5555"])).toEqual(["kb-wp-New5555"]);
  });

  it("with no recorded survivor, uses the work item's den topics in the registry: the Ss47OBh case", () => {
    live("kb-wp-340zBGW");
    live("kb-wp-bWGgKqJ");
    retired("kb-wp-T4pp4qR");
    registry({
      "kb-wp-340zBGW": { entries: ["kb-wp-340zBGW"], aliases: ["work-wp-Ss47OBh", "other-topic"] },
      "kb-wp-bWGgKqJ": { entries: ["kb-wp-bWGgKqJ"], aliases: ["work-wp-Ss47OBh~local-first-pack-topology"] },
    });
    // the notes: created T4pp4qR (later retired), created bWGgKqJ
    expect(resolveRetiredIds(roots, ["kb-wp-T4pp4qR", "kb-wp-bWGgKqJ"], { workId: "work-wp-Ss47OBh" })).toEqual(["kb-wp-340zBGW", "kb-wp-bWGgKqJ"]);
    // the correction note names the survivor: no duplicate
    expect(resolveRetiredIds(roots, ["kb-wp-T4pp4qR", "kb-wp-bWGgKqJ", "kb-wp-340zBGW"], { workId: "work-wp-Ss47OBh" })).toEqual(["kb-wp-bWGgKqJ", "kb-wp-340zBGW"]);
  });

  it("is dropped when the registry fallback is ambiguous or the work item has no topic", () => {
    live("kb-wp-AAAAAAA");
    live("kb-wp-BBBBBBB");
    retired("kb-wp-T4pp4qR");
    registry({
      "kb-wp-AAAAAAA": { entries: ["kb-wp-AAAAAAA"], aliases: ["work-wp-Ss47OBh"] },
      "kb-wp-BBBBBBB": { entries: ["kb-wp-BBBBBBB"], aliases: ["work-wp-Ss47OBh~x"] },
    });
    expect(resolveRetiredIds(roots, ["kb-wp-T4pp4qR"], { workId: "work-wp-Ss47OBh" })).toEqual([]);
    expect(resolveRetiredIds(roots, ["kb-wp-T4pp4qR"])).toEqual([]);
  });
});

describe("mapDeliveredLinks", () => {
  it("rewrites only the links of Delivered bullets", () => {
    const body = "Intro [[kb-wp-Old2222]].\n\n## Delivered\n\n- Feature A: [[kb-wp-Old2222]], [[kb-wp-Live111]]\n- Feature B: [[kb-wp-Gone444]]\n- Feature C\n\n## Other\n\n- [[kb-wp-Old2222]]\n";
    const out = mapDeliveredLinks(body, (ls) => ls.flatMap((l) => (l === "kb-wp-Old2222" ? ["kb-wp-Live111"] : l === "kb-wp-Gone444" ? [] : [l])));
    expect(out).toBe("Intro [[kb-wp-Old2222]].\n\n## Delivered\n\n- Feature A: [[kb-wp-Live111]]\n- Feature B\n- Feature C\n\n## Other\n\n- [[kb-wp-Old2222]]\n");
  });
});
