import { describe, it, expect } from "vitest";
import { renderFrontmatter, parseFrontmatter, type Entry } from "@wolfpack/engine";
import { normalizeEntry } from "./normalize.js";

function fm(overrides: Record<string, unknown> = {}): Entry {
  return {
    frontmatter: {
      id: "kb-wolfpack-ABC1234",
      title: "T",
      type: "architecture",
      domain: "wolfpack",
      status: "active",
      authority: "curated",
      confidence: "high",
      related: [],
      supersedes: [],
      sources: [],
      created: "2026-10-06",
      updated: "2026-10-06",
      historical: false,
      ...overrides,
    },
    summary: "s",
    detail: "d",
  } as unknown as Entry;
}

describe("normalizeEntry", () => {
  it("drops self-references and malformed/duplicate related ids", () => {
    const { entry, warnings } = normalizeEntry(
      fm({
        related: [
          "kb-wolfpack-ABC1234", // self
          "kb-snapjack-rating-system", // malformed (not 7-char id)
          "kb-wolfpack-XYZ7890",
          "kb-wolfpack-XYZ7890", // dup
        ],
      }),
      "wolfpack"
    );
    expect(entry.frontmatter.related).toEqual(["kb-wolfpack-XYZ7890"]);
    expect(warnings.length).toBe(3);
  });

  it("drops an expires that is on/before created", () => {
    const { entry } = normalizeEntry(
      fm({ created: "2026-10-06", expires: "2026-01-10" }),
      "wolfpack"
    );
    expect(entry.frontmatter.expires).toBeUndefined();
  });

  it("flags an id whose prefix disagrees with the domain", () => {
    const { warnings } = normalizeEntry(
      fm({ id: "kb-snapjack-azlIF4j" }),
      "wolfpack"
    );
    expect(warnings.some((w) => w.includes("prefix mismatch"))).toBe(true);
  });

  it("coerces an out-of-vocab type to other + tag", () => {
    const { entry } = normalizeEntry(fm({ type: "RandomKind" }), "wolfpack");
    expect(entry.frontmatter.type).toBe("other");
    expect(entry.frontmatter.tag).toBe("randomkind");
  });

  it("collapses empty subcategory to undefined", () => {
    const { entry } = normalizeEntry(fm({ subcategory: "   " }), "wolfpack");
    expect(entry.frontmatter.subcategory).toBeUndefined();
  });
});

describe("renderFrontmatter determinism", () => {
  it("emits keys in canonical order regardless of insertion order", () => {
    // subcategory inserted LAST (the historical drift case) must still land
    // after `domain`, not at the bottom.
    const out = renderFrontmatter({
      updated: "2026-10-06",
      created: "2026-10-06",
      domain: "wolfpack",
      id: "kb-wolfpack-ABC1234",
      title: "T",
      type: "architecture",
      subcategory: "runtime",
      status: "active",
      authority: "curated",
      confidence: "high",
      related: [],
      supersedes: [],
      sources: [],
    } as never);
    const keys = out
      .split("\n")
      .filter((l) => /^[a-zA-Z]/.test(l))
      .map((l) => l.split(":")[0]);
    expect(keys).toEqual([
      "id",
      "title",
      "type",
      "domain",
      "subcategory",
      "status",
      "authority",
      "confidence",
      "related",
      "supersedes",
      "sources",
      "created",
      "updated",
    ]);
  });

  it("writes related/supersedes as Obsidian wikilinks that round-trip to bare ids", () => {
    const out = renderFrontmatter({
      id: "kb-wolfpack-ABC1234",
      title: "T",
      type: "architecture",
      domain: "wolfpack",
      status: "active",
      authority: "curated",
      confidence: "high",
      related: ["kb-wolfpack-XYZ7890"],
      supersedes: ["kb-wolfpack-OLD4321"],
      sources: ["commit:abc"],
      created: "2026-10-06",
      updated: "2026-10-06",
    } as never);
    // On disk: quoted wikilinks (clickable + graph) for link fields only.
    expect(out).toContain('  - "[[kb-wolfpack-XYZ7890]]"');
    expect(out).toContain('  - "[[kb-wolfpack-OLD4321]]"');
    // sources stay plain (not vault entries).
    expect(out).toContain("  - commit:abc");
    // In memory: parser strips brackets back to bare ids.
    const { fields } = parseFrontmatter(`${out}\n# T\nbody\n`);
    expect(fields.related).toEqual(["kb-wolfpack-XYZ7890"]);
    expect(fields.supersedes).toEqual(["kb-wolfpack-OLD4321"]);
    expect(fields.sources).toEqual(["commit:abc"]);
  });

  it("omits empty optionals and historical:false", () => {
    const out = renderFrontmatter({
      id: "kb-wolfpack-ABC1234",
      title: "T",
      type: "architecture",
      domain: "wolfpack",
      subcategory: "",
      tag: "",
      status: "active",
      authority: "curated",
      confidence: "high",
      related: [],
      supersedes: [],
      sources: [],
      created: "2026-10-06",
      updated: "2026-10-06",
      historical: false,
    } as never);
    expect(out).not.toContain("subcategory:");
    expect(out).not.toContain("tag:");
    expect(out).not.toContain("historical:");
  });
});
