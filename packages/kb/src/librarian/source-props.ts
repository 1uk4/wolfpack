/**
 * Graduation provenance on the entry, set by code only (the model never sees or writes these):
 *   source-feature            the feature (work item id) the knowledge was built under
 *   source-tasks              its tasks (newest 50)
 *   source-record-lines       refs of the Record lines the entry was written from (newest 64)
 *   source-record-lines-scope `record` when the refs are the whole Record, not just the lines that fed this entry
 *                             (the model did not map them, or the entry is the feature's own document)
 *
 * A ref is 8 hex of sha1(group NUL line text) and resolves against the ARCHIVED work item document: graduation
 * archives the item without touching its body, so the document keeps its `## Record` with the per-line
 * `<!-- src: id@timestamp … -->` comments. Those ids resolve in the wolf's `.memory/pool/archive.jsonl`.
 * A merge keeps the earlier values and adds the new ones.
 */
import type { Entry } from "../schema/knowledge.js";
import type { Contribution } from "../shared/index.js";

export const SOURCE_FEATURE = "source-feature";
export const SOURCE_TASKS = "source-tasks";
export const SOURCE_LINES = "source-record-lines";
export const SOURCE_SCOPE = "source-record-lines-scope";
export const MAX_SOURCE_TASKS = 50;
export const MAX_SOURCE_LINES = 64;

export const isSourceKey = (k: string): boolean => /^source-/i.test(k);

const parse = (v: string | undefined): string[] => (v ?? "").split(",").map((t) => t.trim()).filter(Boolean);
const frontmatterRange = (md: string): { start: number; end: number } | null => {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  return m ? { start: 4, end: 4 + m[1].length } : null;
};

/** The `source-*` properties of an entry's markdown (frontmatter `properties:` block). */
export function sourcePropertiesOf(markdown: string | undefined): Record<string, string> {
  const r = markdown ? frontmatterRange(markdown) : null;
  const out: Record<string, string> = {};
  if (!markdown || !r) return out;
  for (const m of markdown.slice(r.start, r.end).matchAll(/^  (source-[a-z-]+):[ \t]*"?(.*?)"?[ \t]*$/gm)) out[m[1]] = m[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  return out;
}

/** The markdown without its `source-*` property lines (what the produce prompt shows the model). */
export function hideSourceProperties(markdown: string): string {
  const r = frontmatterRange(markdown);
  if (!r) return markdown;
  const fm = markdown.slice(r.start, r.end).split("\n").filter((l) => !/^  source-[a-z-]+:/.test(l));
  const cleaned: string[] = [];
  fm.forEach((l, i) => { if (!(l === "properties:" && !/^  /.test(fm[i + 1] ?? ""))) cleaned.push(l); });
  return markdown.slice(0, r.start) + cleaned.join("\n") + markdown.slice(r.end);
}

/** Drop `source-*` keys from a property bag. */
export function dropSourceProps<T extends Record<string, unknown>>(props: T | undefined): T {
  return Object.fromEntries(Object.entries(props ?? {}).filter(([k]) => !isSourceKey(k))) as T;
}

/**
 * The entry with code-computed source properties: whatever the model returned under `source-*` is discarded, the
 * entry's previous values (from its markdown) are kept, and this contribution's source is added to them.
 */
export function withSourceProperties(entry: Entry, source: Contribution["source"], existingMarkdown?: string): Entry {
  const before = sourcePropertiesOf(existingMarkdown);
  const props = dropSourceProps(entry.properties);
  const union = (key: string, add: string[] | undefined, cap: number) => {
    const all = [...new Set([...parse(before[key]), ...(add ?? [])])].slice(-cap);
    if (all.length) props[key] = all.join(", ");
  };
  union(SOURCE_FEATURE, source?.feature ? [source.feature] : undefined, 8);
  union(SOURCE_TASKS, source?.tasks, MAX_SOURCE_TASKS);
  union(SOURCE_LINES, source?.recordLines, MAX_SOURCE_LINES);
  if (source?.recordLinesScope === "record" || before[SOURCE_SCOPE] === "record") props[SOURCE_SCOPE] = "record";
  return { ...entry, properties: props };
}

/** True when the entry's source properties differ from those in `markdown`. */
export function sourceDiffers(markdown: string | undefined, entry: Entry): boolean {
  const now = Object.fromEntries(Object.entries(entry.properties ?? {}).filter(([k]) => isSourceKey(k)));
  return JSON.stringify(sortKeys(sourcePropertiesOf(markdown))) !== JSON.stringify(sortKeys(now));
}
const sortKeys = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Replace the `source-*` lines of an entry's markdown with the entry's, leaving everything else byte for byte. */
export function patchSourceProperties(markdown: string, entry: Entry): string {
  const r = frontmatterRange(markdown);
  if (!r) return markdown;
  const lines = markdown.slice(r.start, r.end).split("\n").filter((l) => !/^  source-[a-z-]+:/.test(l));
  const add = Object.entries(entry.properties ?? {}).filter(([k]) => isSourceKey(k)).map(([k, v]) => `  ${k}: ${q(v)}`);
  if (add.length) {
    const at = lines.indexOf("properties:");
    if (at >= 0) {
      let end = at + 1;
      while (end < lines.length && /^  /.test(lines[end])) end++;
      lines.splice(end, 0, ...add);
    } else {
      const created = lines.findIndex((l) => l.startsWith("created:"));
      lines.splice(created >= 0 ? created : lines.length, 0, "properties:", ...add);
    }
  } else {
    const at = lines.indexOf("properties:");
    if (at >= 0 && !/^  /.test(lines[at + 1] ?? "")) lines.splice(at, 1);
  }
  return markdown.slice(0, r.start) + lines.join("\n") + markdown.slice(r.end);
}
