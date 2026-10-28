import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildKbGraph, UnknownDomainError } from "./build.js";
import { readKbEntry } from "./entry.js";
import { makeFixtureKb } from "./fixture.js";

const base = makeFixtureKb();
const roots = { kbBase: base };
const ids = (g: ReturnType<typeof buildKbGraph>, kind?: string) => g.nodes.filter((n) => !kind || n.kind === kind).map((n) => n.id);
const edgeSet = (g: ReturnType<typeof buildKbGraph>, kind: string) => g.edges.filter((e) => e.kind === kind).map((e) => `${e.source}>${e.target}`);

describe("buildKbGraph: default layers", () => {
  const g = buildKbGraph(roots, { now: () => new Date("2026-01-01T00:00:00Z") });
  it("has domain, section, entry and open work nodes with prefixed ids and kind depths", () => {
    expect(ids(g, "domain")).toEqual(["dom:alpha", "dom:beta"]);
    expect(ids(g, "factory")).toEqual(["fac:alpha"]);
    expect(ids(g, "section")).toEqual(["sec:sec-alpha-sub", "sec:sec-alpha-top"]);
    expect(ids(g, "entry")).toEqual(["ent:kb-alpha-AAA1111", "ent:kb-alpha-BBB2222", "ent:kb-alpha-CCC3333", "ent:kb-beta-DDD4444"]);
    expect(ids(g, "work")).toEqual(["work:work-alpha-CHILD11", "work:work-alpha-ROOT111"]);
    expect(g.nodes.map((n) => [n.kind, n.depth]).filter((v, i, a) => a.findIndex((x) => x[0] === v[0]) === i)).toEqual([["domain", 0], ["factory", 1], ["section", 1], ["entry", 2], ["work", 3]]);
    expect(g.generated).toBe("2026-01-01T00:00:00.000Z");
    expect(g.domain).toBeNull();
    expect(g.layers).toEqual({ archivedWork: false, denTopics: false });
  });
  it("carries kind-specific fields", () => {
    const by = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    expect(by["ent:kb-alpha-AAA1111"]).toMatchObject({ label: "First", maturity: "active", entryKind: "reference", sectionId: "sec-alpha-top", domain: "alpha", summary: "About First" });
    expect(by["ent:kb-alpha-BBB2222"].sectionId).toBe("sec-alpha-sub");
    expect(by["ent:kb-alpha-CCC3333"].sectionId).toBeUndefined();
    expect(by["work:work-alpha-CHILD11"]).toMatchObject({ stage: "in_build", workKind: "task" });
    expect(by["sec:sec-alpha-top"]).toMatchObject({ summary: "Top section", currency: "live" });
  });
  it("builds the hierarchy (domain → factory → work) plus partOf and dependsOn, and no relation edges", () => {
    expect(edgeSet(g, "hierarchy")).toEqual([
      "dom:alpha>ent:kb-alpha-CCC3333",
      "dom:alpha>fac:alpha",
      "dom:alpha>sec:sec-alpha-top",
      "dom:beta>ent:kb-beta-DDD4444",
      "fac:alpha>work:work-alpha-ROOT111",
      "sec:sec-alpha-sub>ent:kb-alpha-BBB2222",
      "sec:sec-alpha-top>ent:kb-alpha-AAA1111",
      "sec:sec-alpha-top>sec:sec-alpha-sub",
      "work:work-alpha-ROOT111>work:work-alpha-CHILD11",
    ]);
    expect(edgeSet(g, "partOf")).toEqual(["work:work-alpha-CHILD11>work:work-alpha-ROOT111"]);
    // the archived dependency is not in this layer, so its edge is dropped (as is the one to a missing item)
    expect(edgeSet(g, "dependsOn")).toEqual([]);
    // entries relate to each other in the files (relations, [[wikilinks]]), but the graph draws none of it
    expect(new Set(g.edges.map((e) => e.kind))).toEqual(new Set(["hierarchy", "partOf"]));
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
  it("denTopics adds only the supplied wolf's topics, with no relation edges", () => {
    const den = { wolf: "dewey", topics: [{ id: "caching", title: "Caching", summary: "s", updated: "2026-01-01", related: ["kb-alpha-AAA1111", "gone"], promotable: true }, { id: "work-alpha-ROOT111~notes", title: "Notes", summary: "", updated: "", related: ["caching"], promotable: false }] };
    expect(ids(buildKbGraph(roots, { den }), "den-topic")).toEqual([]);
    const g = buildKbGraph(roots, { den, denTopics: true });
    expect(ids(g, "den-topic")).toEqual(["den:dewey:caching", "den:dewey:work-alpha-ROOT111~notes"]);
    expect(g.nodes.find((n) => n.id === "den:dewey:caching")).toMatchObject({ kind: "den-topic", depth: 4, wolf: "dewey", promotable: true });
    expect(g.edges.some((e) => e.source.startsWith("den:") || e.target.startsWith("den:"))).toBe(false);
  });
  it("domain filter keeps one domain, drops cross-domain edges, and lists all domains", () => {
    const g = buildKbGraph(roots, { domain: "alpha" });
    expect(g.domain).toBe("alpha");
    expect(ids(g, "domain")).toEqual(["dom:alpha"]);
    expect(g.nodes.every((n) => n.domain === "alpha")).toBe(true);
    expect(ids(g, "factory")).toEqual(["fac:alpha"]);
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

const put = (file: string, text: string) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
};

describe("id consistency and edge cases", () => {
  it("readKbEntry resolves a frontmatter id that differs from the filename, as the graph emits it", () => {
    const kb = makeFixtureKb();
    put(join(kb, "domains/alpha/entries/renamed-file.md"), "---\nid: kb-alpha-ZZZ9999\ntitle: Renamed\n---\nHello [[kb-alpha-AAA1111]]\n");
    const g = buildKbGraph({ kbBase: kb });
    expect(g.nodes.map((n) => n.id)).toContain("ent:kb-alpha-ZZZ9999");
    expect(readKbEntry({ kbBase: kb }, "kb-alpha-ZZZ9999")).toMatchObject({ title: "Renamed", domain: "alpha" });
    expect(readKbEntry({ kbBase: kb }, "renamed-file")).toBeNull();
    expect(readKbEntry({ kbBase: kb }, "kb-alpha-AAA1111")!.backlinks).toContainEqual({ id: "kb-alpha-ZZZ9999", title: "Renamed", via: "wikilink" });
  });
  it("wikilinks to a non-work file in work/ do not exist, and backlinks are deduped", () => {
    const kb = makeFixtureKb();
    put(join(kb, "domains/alpha/entries/kb-alpha-AAA1111.md"), "---\nid: kb-alpha-AAA1111\ntitle: First\n---\n[[notes]] [[kb-alpha-BBB2222]]\n");
    expect(readKbEntry({ kbBase: kb }, "kb-alpha-AAA1111")!.wikilinks).toEqual([{ target: "notes", exists: false }, { target: "kb-alpha-BBB2222", exists: true }]);
    put(join(kb, "domains/alpha/entries/kb-alpha-BBB2222.md"), "---\nid: kb-alpha-BBB2222\ntitle: Second\n---\n[[kb-alpha-AAA1111]] [[kb-alpha-AAA1111|again]]\n");
    expect(readKbEntry({ kbBase: kb }, "kb-alpha-AAA1111")!.backlinks.filter((b) => b.via === "wikilink")).toHaveLength(1);
  });
  it("an entry or section id claimed by two domains keeps the first and takes no edges from the second", () => {
    const kb = makeFixtureKb();
    put(join(kb, "domains/beta/entries/kb-alpha-AAA1111.md"), "---\nid: kb-alpha-AAA1111\ntitle: Dup\nrelations:\n  - kind: refines\n    target: kb-beta-DDD4444\n---\nx\n");
    put(join(kb, "domains/beta/_digest.json"), JSON.stringify({ sections: [{ sectionId: "sec-alpha-top", title: "Dup", entryIds: ["kb-alpha-AAA1111"], children: [] }] }));
    const g = buildKbGraph({ kbBase: kb });
    expect(g.nodes.find((n) => n.id === "ent:kb-alpha-AAA1111")).toMatchObject({ domain: "alpha", label: "First" });
    expect(g.nodes.find((n) => n.id === "sec:sec-alpha-top")!.domain).toBe("alpha");
    expect(g.edges.some((e) => e.source === "dom:beta" && e.target === "sec:sec-alpha-top")).toBe(false);
    expect(g.edges.some((e) => e.target === "ent:kb-alpha-AAA1111" && e.source.startsWith("dom:beta"))).toBe(false);
    expect(g.edges.some((e) => e.source === "ent:kb-alpha-AAA1111" && e.target === "ent:kb-beta-DDD4444")).toBe(false);
  });
  it("work items in a partOf cycle attach to the Factory", () => {
    const kb = makeFixtureKb();
    const w = (id: string, p: string) => put(join(kb, `domains/alpha/work/${id}.md`), `---\nid: ${id}\nnodeType: work\nstage: plan\npartOf: ${p}\n---\n`);
    w("work-alpha-CYC1111", "work-alpha-CYC2222");
    w("work-alpha-CYC2222", "work-alpha-CYC1111");
    const g = buildKbGraph({ kbBase: kb });
    expect(g.edges).toContainEqual({ source: "fac:alpha", target: "work:work-alpha-CYC1111", kind: "hierarchy" });
    expect(g.edges).toContainEqual({ source: "fac:alpha", target: "work:work-alpha-CYC2222", kind: "hierarchy" });
    expect(g.edges.filter((e) => e.kind === "partOf" && e.source.includes("CYC"))).toEqual([]);
  });
  it("a domain without work gets no Factory node", () => {
    const g = buildKbGraph(roots);
    expect(ids(g, "factory")).toEqual(["fac:alpha"]);
    expect(g.edges.some((e) => e.target === "fac:beta")).toBe(false);
  });
  it("the archived Factory child hangs off its parent only with the archivedWork layer", () => {
    const g = buildKbGraph(roots, { archivedWork: true });
    expect(g.edges).toContainEqual({ source: "work:work-alpha-ROOT111", target: "work:work-alpha-OLD1111", kind: "hierarchy" });
    expect(g.edges).toContainEqual({ source: "fac:alpha", target: "work:work-alpha-ROOT111", kind: "hierarchy" });
  });
  it("work from the Work API replaces the work files: one Factory per domain, items parented by partOf", () => {
    const kb = makeFixtureKb();
    const work = [
      { id: "w-feat", domain: "alpha", title: "Feature", kind: "feature", stage: "in_build" },
      { id: "w-task", domain: "alpha", title: "Task", kind: "task", stage: "plan", partOf: "w-feat", dependsOn: ["w-feat"], assignee: "1uk4" },
      { id: "w-old", domain: "alpha", title: "Old", stage: "archived" },
      { id: "w-beta", domain: "beta", title: "Beta thing", stage: "idea" },
      { id: "w-gone", domain: "nowhere", title: "Unknown domain" },
    ];
    const g = buildKbGraph({ kbBase: kb }, { work });
    expect(ids(g, "work")).toEqual(["work:w-beta", "work:w-feat", "work:w-task"]);
    expect(ids(g, "factory")).toEqual(["fac:alpha", "fac:beta"]);
    expect(g.edges).toContainEqual({ source: "dom:alpha", target: "fac:alpha", kind: "hierarchy" });
    expect(g.edges).toContainEqual({ source: "dom:beta", target: "fac:beta", kind: "hierarchy" });
    expect(g.edges).toContainEqual({ source: "fac:alpha", target: "work:w-feat", kind: "hierarchy" });
    expect(g.edges).toContainEqual({ source: "fac:beta", target: "work:w-beta", kind: "hierarchy" });
    expect(g.edges).toContainEqual({ source: "work:w-feat", target: "work:w-task", kind: "hierarchy" });
    expect(g.edges).toContainEqual({ source: "work:w-task", target: "work:w-feat", kind: "partOf" });
    expect(g.nodes.find((n) => n.id === "work:w-task")).toMatchObject({ workKind: "task", stage: "plan", assignee: "1uk4", domain: "alpha" });
    // none of the file items leak in
    expect(ids(g, "work")).not.toContain("work:work-alpha-ROOT111");
    // archived hidden by default, shown with the layer
    expect(ids(buildKbGraph({ kbBase: kb }, { work, archivedWork: true }), "work")).toContain("work:w-old");
    // an empty API answer means no work (not the files)
    expect(ids(buildKbGraph({ kbBase: kb }, { work: [] }), "factory")).toEqual([]);
  });
  it("an item whose parent is missing from the API answer attaches to the Factory", () => {
    const g = buildKbGraph({ kbBase: makeFixtureKb() }, { work: [{ id: "w1", domain: "alpha", partOf: "w-missing" }] });
    expect(g.edges).toContainEqual({ source: "fac:alpha", target: "work:w1", kind: "hierarchy" });
  });
  it("domains.yaml colours are validated", () => {
    const kb = makeFixtureKb();
    const colors = ["#abc", "#aabbcc", "#aabbccdd", "rgb(1, 2, 3)", "hsl(10 20% 30%)", "tomato", "url(x)", "#ggg", "red;x"];
    put(join(kb, "domains.yaml"), "domains:\n" + colors.map((c, i) => `  d${i}:\n    label: D\n    color: '${c}'\n`).join(""));
    for (let i = 0; i < colors.length; i++) mkdirSync(join(kb, `domains/d${i}`), { recursive: true });
    const got = Object.fromEntries(buildKbGraph({ kbBase: kb }).domains.filter((d) => d.name.startsWith("d")).map((d) => [d.name, d.color]));
    expect(Object.values(got).slice(0, 6)).toEqual(colors.slice(0, 6));
    expect([got.d6, got.d7, got.d8]).toEqual([undefined, undefined, undefined]);
  });
});
