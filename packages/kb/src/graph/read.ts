/** Tolerant readers for the KB's markdown + yaml files: a bad file is skipped, never fatal. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";

export interface Parsed {
  meta: Record<string, unknown>;
  body: string;
}

export function parseMarkdown(text: string): Parsed {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  try {
    const meta = yamlParse(m[1]);
    return { meta: meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {}, body: m[2] };
  } catch {
    return { meta: {}, body: m[2] };
  }
}

export const str = (v: unknown): string | undefined => (typeof v === "string" ? v || undefined : typeof v === "number" ? String(v) : undefined);

export const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** `*.md` files of a directory as parsed markdown, sorted by filename; unreadable files are skipped. */
export function readMarkdownDir(dir: string): Array<Parsed & { file: string }> {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const out: Array<Parsed & { file: string }> = [];
  for (const f of names) {
    try {
      out.push({ ...parseMarkdown(readFileSync(join(dir, f), "utf-8")), file: f });
    } catch {
      continue;
    }
  }
  return out;
}

export interface DigestSection {
  sectionId: string;
  title: string;
  summary: string;
  currency: string;
  entryIds: string[];
  children: DigestSection[];
}

function section(raw: unknown): DigestSection | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const sectionId = str(r.sectionId);
  if (!sectionId) return null;
  return {
    sectionId,
    title: str(r.title) ?? sectionId,
    summary: str(r.summary) ?? "",
    currency: str(r.currency) ?? "",
    entryIds: strList(r.entryIds),
    children: Array.isArray(r.children) ? r.children.map(section).filter((s): s is DigestSection => s !== null) : [],
  };
}

/** The domain's section tree from `_digest.json`; [] when it is missing or corrupt. */
export function readDigestSections(domainDir: string): DigestSection[] {
  try {
    const d = JSON.parse(readFileSync(join(domainDir, "_digest.json"), "utf-8")) as { sections?: unknown };
    return Array.isArray(d.sections) ? d.sections.map(section).filter((s): s is DigestSection => s !== null) : [];
  } catch {
    return [];
  }
}

export interface RawRelation {
  kind: string;
  target: string;
}

/** Typed relations from `relations: [{kind,target}]` (current) or the older `related: [{rel,target}]` / bare ids. */
export function readRelations(meta: Record<string, unknown>): RawRelation[] {
  const out: RawRelation[] = [];
  for (const [key, fallback] of [["relations", "see_also"], ["related", "see_also"]] as const) {
    const v = meta[key];
    if (!Array.isArray(v)) continue;
    for (const r of v) {
      if (typeof r === "string") out.push({ kind: fallback, target: r });
      else if (r && typeof r === "object") {
        const o = r as Record<string, unknown>;
        const target = str(o.target);
        if (target) out.push({ kind: str(o.kind) ?? str(o.rel) ?? fallback, target });
      }
    }
  }
  return out;
}
