import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildKbGraph, UnknownDomainError } from "./build.js";
import { readKbEntry } from "./entry.js";
import { makeFixtureKb } from "./fixture.js";

const base = makeFixtureKb();
const roots = { kbBase: base };
const ids = (g: ReturnType<typeof buildKbGraph>, kind?: string) => g.nodes.filter((n) => !kind || n.kind === kind).map((n) => n.id);
const edgeSet = (g: ReturnType<typeof buildKbGraph>, kind: string) => g.edges.filter((e) => e.kind === kind).map((e) => `${e.source}>${e.target}${e.relation ? `:${e.relation}` : ""}`);

describe("buildKbGraph: default layers", () => {
  const g = buildKbGraph(roots, { now: () => new Date("2026-01-01T00:00:00Z") });
  it("has domain, section, entry and open work nodes with prefixed ids and kind depths", () => {
    expect(ids(g, "domain")).toEqual(["dom:alpha", "dom:beta"]);
    expect(ids(g, "section")).toEqual(["sec:sec-alpha-sub", "sec:sec-alpha-top"]);
    expect(ids(g, "entry")).toEqual(["ent:kb-alpha-AAA1111", "ent:kb-alpha-BBB2222", "ent:kb-alpha-CCC3333", "ent:kb-beta-DDD4444"]);
    expect(ids(g, "work")).toEqual(["work:work-alpha-CHILD11", "work:work-alpha-ROOT111"]);
    expect(g.nodes.map((n) => [n.kind, n.depth]).filter((v, i, a) => a.findIndex((x) => x[0] === v[0]) === i)).toEqual([["domain", 0], ["section", 1], ["entry", 2], ["work", 3]]);
    expect(g.generated).toBe("2026-01-01T00:00:00.000Z");
    expect(g.domain).toBeNull();
    expect(g.layers).toEqual({ archivedWork: false, wikilinks: false, denTopics: false });
  });
  it("carries kind-specific fields", () => {
    const by = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    expect(by["ent:kb-alpha-AAA1111"]).toMatchObject({ label: "First", maturity: "active", entryKind: "reference", sectionId: "sec-alpha-top", domain: "alpha", summary: "About First" });
    expect(by["ent:kb-alpha-BBB2222"].sectionId).toBe("sec-alpha-sub");
    expect(by["ent:kb-alpha-CCC3333"].sectionId).toBeUndefined();
    expect(by["work:work-alpha-CHILD11"]).toMatchObject({ stage: "in_build", workKind: "task" });
    expect(by["sec:sec-alpha-top"]).toMatchObject({ summary: "Top section", currency: "live" });
  });
  it("builds hierarchy, partOf, dependsOn and related edges", () => {
    expect(edgeSet(g, "hierarchy")).toEqual([
      "dom:alpha>ent:kb-alpha-CCC3333",
      "dom:alpha>sec:sec-alpha-top",
      "dom:alpha>work:work-alpha-ROOT111",
      "dom:beta>ent:kb-beta-DDD4444",
      "sec:sec-alpha-sub>ent:kb-alpha-BBB2222",
      "sec:sec-alpha-top>ent:kb-alpha-AAA1111",
      "sec:sec-alpha-top>sec:sec-alpha-sub",
      "work:work-alpha-ROOT111>work:work-alpha-CHILD11",
    ]);
    expect(edgeSet(g, "partOf")).toEqual(["work:work-alpha-CHILD11>work:work-alpha-ROOT111"]);
    // the archived dependency is not in this layer, so its edge is dropped (as is the one to a missing item)
    expect(edgeSet(g, "dependsOn")).toEqual([]);
    expect(edgeSet(g, "related")).toEqual(["ent:kb-alpha-AAA1111>ent:kb-alpha-BBB2222:refines", "ent:kb-alpha-BBB2222>ent:kb-beta-DDD4444:see_also"]);
    expect(edgeSet(g, "wikilink")).toEqual([]);
  });
  it("never dangles, never duplicates and is deterministic", () => {
    const idset = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges) expect(idset.has(e.source) && idset.has(e.target)).toBe(true);
    expect(new Set(g.edges.map((e) => JSON.stringify(e))).size).toBe(g.edges.length);
    expect(buildKbGraph(roots, { now: () => new Date("2026-01-01T00:00:00Z") })).toEqual(g);
  });
  it("passes the domain colour through, only where set", () => {
    expect(g.domains).toEqual([{ name: "alpha", label: "Alpha Land", color: "#ff8800" }, { name: "beta", label: "Beta" }]);
  });
  it("survives a corrupt digest and a corrupt entry", () => {
    expect(ids(g, "entry")).toContain("ent:kb-beta-DDD4444");
    expect(edgeSet(g, "hierarchy")).toContain("dom:beta>ent:kb-beta-DDD4444");
  });
});

describe("buildKbGraph: toggles and filter", () => {
  it("archivedWork adds archived items and their edges", () => {
    const g = buildKbGraph(roots, { archivedWork: true });
    expect(ids(g, "work")).toContain("work:work-alpha-OLD1111");
    expect(edgeSet(g, "dependsOn")).toEqual(["work:work-alpha-CHILD11>work:work-alpha-OLD1111"]);
    expect(g.layers.archivedWork).toBe(true);
    expect(ids(buildKbGraph(roots), "work")).not.toContain("work:work-alpha-OLD1111");
  });
  it("wikilinks adds body links to existing entries only, skipping code fences and unknown targets", () => {
    const g = buildKbGraph(roots, { wikilinks: true });
    expect(edgeSet(g, "wikilink")).toEqual(["ent:kb-alpha-AAA1111>ent:kb-alpha-BBB2222", "ent:kb-alpha-BBB2222>ent:kb-alpha-AAA1111"]);
    expect(g.nodes).toEqual(buildKbGraph(roots).nodes);
  });
  it("denTopics adds only the supplied wolf's topics, linked to entries and work", () => {
    const den = { wolf: "dewey", topics: [{ id: "caching", title: "Caching", summary: "s", updated: "2026-01-01", related: ["kb-alpha-AAA1111", "gone"], promotable: true }, { id: "work-alpha-ROOT111~notes", title: "Notes", summary: "", updated: "", related: ["caching"], promotable: false }] };
    expect(ids(buildKbGraph(roots, { den }), "den-topic")).toEqual([]);
    const g = buildKbGraph(roots, { den, denTopics: true });
    expect(ids(g, "den-topic")).toEqual(["den:dewey:caching", "den:dewey:work-alpha-ROOT111~notes"]);
    expect(g.nodes.find((n) => n.id === "den:dewey:caching")).toMatchObject({ kind: "den-topic", depth: 4, wolf: "dewey", promotable: true });
    expect(edgeSet(g, "related")).toEqual(expect.arrayContaining(["den:dewey:caching>ent:kb-alpha-AAA1111:see_also", "den:dewey:work-alpha-ROOT111~notes>den:dewey:caching:see_also", "den:dewey:work-alpha-ROOT111~notes>work:work-alpha-ROOT111:work"]));
    expect(g.edges.some((e) => e.target === "ent:gone")).toBe(false);
  });
  it("domain filter keeps one domain, drops cross-domain edges, and lists all domains", () => {
    const g = buildKbGraph(roots, { domain: "alpha", wikilinks: true });
    expect(g.domain).toBe("alpha");
    expect(ids(g, "domain")).toEqual(["dom:alpha"]);
    expect(g.nodes.every((n) => n.domain === "alpha")).toBe(true);
    expect(edgeSet(g, "related")).toEqual(["ent:kb-alpha-AAA1111>ent:kb-alpha-BBB2222:refines"]);
    expect(g.domains.map((d) => d.name)).toEqual(["alpha", "beta"]);
  });
  it("an unknown or unsafe domain throws UnknownDomainError", () => {
    for (const d of ["nope", "../alpha", ""]) expect(() => buildKbGraph(roots, { domain: d })).toThrow(UnknownDomainError);
  });
  it("an empty KB yields an empty graph", () => {
    const empty = join(base, "..", "kb-graph-empty");
    mkdirSync(empty, { recursive: true });
    writeFileSync(join(empty, "x"), "");
    expect(buildKbGraph({ kbBase: empty })).toMatchObject({ nodes: [], edges: [], domains: [] });
  });
});

describe("readKbEntry", () => {
  it("returns body, frontmatter, wikilinks with existence and backlinks", () => {
    const e = readKbEntry(roots, "kb-alpha-AAA1111")!;
    expect(e).toMatchObject({ id: "kb-alpha-AAA1111", title: "First", domain: "alpha" });
    expect(e.frontmatter).toMatchObject({ maturity: "active", kind: "reference" });
    expect(e.body).toContain("See [[kb-alpha-BBB2222]]");
    expect(e.wikilinks).toEqual([{ target: "kb-alpha-BBB2222", exists: true }, { target: "kb-alpha-missing", exists: false }]);
    expect(e.backlinks).toEqual([{ id: "kb-alpha-BBB2222", title: "Second", via: "wikilink" }]);
    const b = readKbEntry(roots, "kb-alpha-BBB2222")!;
    expect(b.backlinks).toEqual([{ id: "kb-alpha-AAA1111", title: "First", via: "related", relation: "refines" }, { id: "kb-alpha-AAA1111", title: "First", via: "wikilink" }]);
    expect(readKbEntry(roots, "kb-beta-DDD4444")!.backlinks).toEqual([{ id: "kb-alpha-BBB2222", title: "Second", via: "related", relation: "see_also" }]);
  });
  it("is null for unknown ids and for traversal", () => {
    for (const id of ["nope", "..", "../domains.yaml", "alpha/entries/kb-alpha-AAA1111", "", "a\0b", "bad"]) expect(readKbEntry(roots, id)).toBeNull();
  });
});
