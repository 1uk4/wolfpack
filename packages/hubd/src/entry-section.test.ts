import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { KbRoots } from "@wolfpack/kb/shared";
import { resolveEntrySection } from "./entry-section.js";

let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("finds the domain and section of an entry from its frontmatter, and nothing for an unknown entry", () => {
  dir = mkdtempSync(join(tmpdir(), "entry-section-"));
  const entries = join(dir, "base", "domains", "wp", "entries");
  mkdirSync(entries, { recursive: true });
  writeFileSync(join(entries, "kb-wp-aaaaaaa.md"), "---\nid: kb-wp-aaaaaaa\ndomain: wp\nsection: sec-1\n---\nbody\n");
  writeFileSync(join(entries, "kb-wp-bbbbbbb.md"), "---\nid: kb-wp-bbbbbbb\ndomain: wp\n---\nbody\n");
  const roots = { kbBase: join(dir, "base"), denLocal: join(dir, "den") } as unknown as KbRoots;
  expect(resolveEntrySection(roots, "kb-wp-aaaaaaa")).toEqual({ domain: "wp", section: "sec-1" });
  expect(resolveEntrySection(roots, "kb-wp-bbbbbbb")).toEqual({ domain: "wp" });
  expect(resolveEntrySection(roots, "kb-wp-zzzzzzz")).toBeUndefined();
  expect(resolveEntrySection(roots, "../etc")).toBeUndefined();
});

it("gives the section chain from the top of the tree down to the entry's section", () => {
  dir = mkdtempSync(join(tmpdir(), "entry-section-"));
  const entries = join(dir, "base", "domains", "wp", "entries");
  mkdirSync(entries, { recursive: true });
  mkdirSync(join(dir, "den", "sections"), { recursive: true });
  writeFileSync(join(entries, "kb-wp-aaaaaaa.md"), "---\nid: kb-wp-aaaaaaa\ndomain: wp\nsection: sec-c\n---\nbody\n");
  const sec = (id: string, parent: string | null, title: string) => ({ id, parent, title });
  writeFileSync(join(dir, "den", "sections", "_sections.json"), JSON.stringify([sec("sec-a", null, "Top"), sec("sec-b", "sec-a", "Middle"), sec("sec-c", "sec-b", "Leaf")]));
  const roots = { kbBase: join(dir, "base"), denLocal: join(dir, "den") } as unknown as KbRoots;
  expect(resolveEntrySection(roots, "kb-wp-aaaaaaa")).toEqual({ domain: "wp", section: "sec-c", sectionPath: ["sec-a", "sec-b", "sec-c"], sectionTitle: "Leaf" });
});
