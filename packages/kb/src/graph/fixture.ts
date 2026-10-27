/** A small fixture KB on disk for the graph tests (also used by the wolfd route test). */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const w = (file: string, text: string) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
};
const entry = (id: string, title: string, extra = "", body = "Body.") =>
  `---\nid: ${id}\ntitle: "${title}"\ndomain: DOM\nkind: reference\nmaturity: active\nauthority: curated\ncurrency: live\nsummary: "About ${title}"\n${extra}---\n\n${body}\n`;
const work = (id: string, extra: string) => `---\nid: ${id}\nnodeType: work\nkind: task\ndomain: alpha\ntitle: "${id} title"\n${extra}---\n\n# ${id}\n`;

/** Domains alpha (colour set, 3 entries, 2-level sections, 4 work items) and beta (1 entry, corrupt digest). Returns kbBase. */
export function makeFixtureKb(): string {
  const base = mkdtempSync(join(tmpdir(), "kb-graph-"));
  w(join(base, "domains.yaml"), "domains:\n  alpha:\n    label: Alpha Land\n    color: '#ff8800'\n  beta:\n    label: Beta\n");
  const a = join(base, "domains/alpha");
  w(join(a, "entries/kb-alpha-AAA1111.md"), entry("kb-alpha-AAA1111", "First", "relations:\n  - kind: refines\n    target: kb-alpha-BBB2222\n    source: code\n", "See [[kb-alpha-BBB2222]] and [[kb-alpha-missing]].\n\n```\n[[kb-alpha-CCC3333]]\n```").replace("domain: DOM", "domain: alpha"));
  w(join(a, "entries/kb-alpha-BBB2222.md"), entry("kb-alpha-BBB2222", "Second", "related:\n  - rel: see_also\n    target: kb-beta-DDD4444\n", "Links [[kb-alpha-AAA1111|first]].").replace("domain: DOM", "domain: alpha"));
  w(join(a, "entries/kb-alpha-CCC3333.md"), entry("kb-alpha-CCC3333", "Orphan").replace("domain: DOM", "domain: alpha"));
  w(join(a, "entries/bad.md"), "---\n: : not yaml [\n---\nbody\n");
  w(
    join(a, "_digest.json"),
    JSON.stringify({
      domain: "alpha",
      sections: [
        { sectionId: "sec-alpha-top", title: "Top", summary: "Top section", currency: "live", entryIds: ["kb-alpha-AAA1111", "kb-alpha-gone"], children: [{ sectionId: "sec-alpha-sub", title: "Sub", summary: "", currency: "", entryIds: ["kb-alpha-BBB2222"], children: [] }] },
      ],
    }),
  );
  w(join(a, "work/work-alpha-ROOT111.md"), work("work-alpha-ROOT111", "stage: plan\n"));
  w(join(a, "work/work-alpha-CHILD11.md"), work("work-alpha-CHILD11", "stage: in_build\npartOf: work-alpha-ROOT111\ndependsOn:\n  - work-alpha-OLD1111\n  - work-alpha-NOPE111\n"));
  w(join(a, "work/work-alpha-OLD1111.md"), work("work-alpha-OLD1111", "stage: archived\npartOf: work-alpha-ROOT111\n"));
  w(join(a, "work/notes.md"), "---\ntitle: not a work item\n---\n");
  const b = join(base, "domains/beta");
  w(join(b, "entries/kb-beta-DDD4444.md"), entry("kb-beta-DDD4444", "Beta one").replace("domain: DOM", "domain: beta"));
  w(join(b, "_digest.json"), "{ not json");
  return base;
}
