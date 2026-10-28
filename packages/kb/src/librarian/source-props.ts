/**
 * Graduation provenance on the entry: the contribution's `source` becomes properties
 *   source-feature      the feature (work item id) the knowledge was built under
 *   source-tasks        its tasks
 *   source-record-lines refs of the Record lines it was written from (the feature's Record holds the
 *                       observation ids and timestamps of each line; the observation archive holds the observations)
 * Set by code after produce (the model never writes them). A merge keeps the earlier values and adds the new ones.
 */
import type { Entry } from "../schema/knowledge.js";
import type { Contribution } from "../shared/index.js";

const KEYS = { feature: "source-feature", tasks: "source-tasks", recordLines: "source-record-lines" } as const;

const parse = (v: string | undefined): string[] => (v ?? "").split(",").map((t) => t.trim()).filter(Boolean);

/** The `source-*` properties of an entry's markdown (frontmatter `properties:` block). */
export function sourcePropertiesOf(markdown: string | undefined): Record<string, string> {
  const fm = markdown ? /^---\n([\s\S]*?)\n---/.exec(markdown)?.[1] : undefined;
  const out: Record<string, string> = {};
  if (!fm) return out;
  for (const m of fm.matchAll(/^  (source-[a-z-]+):[ \t]*"?(.*?)"?[ \t]*$/gm)) out[m[1]] = m[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  return out;
}

export function withSourceProperties(entry: Entry, source: Contribution["source"], existingMarkdown?: string): Entry {
  if (!source) return entry;
  const before = sourcePropertiesOf(existingMarkdown);
  const next: Record<string, string> = {};
  const union = (key: string, add: string[] | undefined) => {
    const all = [...new Set([...parse(before[key]), ...parse(entry.properties?.[key]), ...(add ?? [])])];
    if (all.length) next[key] = all.join(", ");
  };
  union(KEYS.feature, source.feature ? [source.feature] : undefined);
  union(KEYS.tasks, source.tasks);
  union(KEYS.recordLines, source.recordLines);
  return { ...entry, properties: { ...entry.properties, ...next } };
}
