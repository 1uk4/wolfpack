/**
 * Deterministic guards around the produce call: what the model must not be
 * trusted to keep. Existing History lines, existing relations and the
 * render layout (H1 + lede) are restored/normalised in code.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";
import { type KbRoots, entriesDir } from "../shared/index.js";
import { Relation } from "../schema/knowledge.js";

/** Past this many History lines the model may fold the oldest ones, so the guard stands down. */
export const HISTORY_FOLD_AT = 15;

const HISTORY_HEADING = /^## History[ \t]*$/m;

/** The `- ...` lines of an entry's final `## History` section. */
export function historyLines(markdown: string): string[] {
  return bodyHistory(markdown.replace(/^---\n[\s\S]*?\n---\n?/, ""));
}

function bodyHistory(body: string): string[] {
  const at = body.search(HISTORY_HEADING);
  if (at < 0) return [];
  const section = body.slice(at).replace(HISTORY_HEADING, "");
  const next = section.search(/^## /m);
  return (next < 0 ? section : section.slice(0, next))
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "));
}

const norm = (l: string) => l.replace(/\s+/g, " ").trim();

/**
 * Re-add any History line of `previous` that `detail` lost. Lost lines go
 * first (they are older), then the model's own. Returns the detail and the
 * lines restored. Stands down when `previous` is already past the fold limit.
 */
export function preserveHistory(previous: string | undefined, detail: string): { detail: string; restored: string[] } {
  const old = previous ? historyLines(previous) : [];
  if (old.length === 0 || old.length > HISTORY_FOLD_AT) return { detail, restored: [] };
  const have = new Set(bodyHistory(detail).map(norm));
  const restored = old.filter((l) => !have.has(norm(l)));
  if (restored.length === 0) return { detail, restored };

  const at = detail.search(HISTORY_HEADING);
  if (at < 0) {
    return { detail: `${detail.trimEnd()}\n\n## History\n\n${restored.join("\n")}\n`, restored };
  }
  const headEnd = at + detail.slice(at).indexOf("\n");
  const head = headEnd > at ? detail.slice(0, headEnd + 1) : `${detail}\n`;
  const rest = headEnd > at ? detail.slice(headEnd + 1).replace(/^\n+/, "") : "";
  return { detail: `${head}\n${restored.join("\n")}${rest ? `\n${rest}` : "\n"}`, restored };
}

/**
 * The entry is rendered as `# title`, the summary, then the detail. Drop a
 * leading H1 from the detail, and the paragraph after it when it repeats the
 * summary or the previous entry's lede.
 */
export function normalizeDetail(detail: string, summary: string, previous?: string): string {
  let out = detail.replace(/^\s+/, "");
  const h1 = /^# [^\n]*\n+/.exec(out);
  if (h1) out = out.slice(h1[0].length);
  const lede = new Set([norm(summary)]);
  if (previous) {
    const m = /^#\s+[^\n]*\n+([\s\S]*?)(?:\n\s*\n|$)/.exec(previous.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/^\s+/, ""));
    if (m?.[1]) lede.add(norm(m[1]));
  }
  const first = /^([^\n#][^\n]*(?:\n(?!\s*\n)[^\n]*)*)(?:\n\s*\n|$)/.exec(out);
  if (first && lede.has(norm(first[1]))) out = out.slice(first[0].length);
  return out.replace(/^\s+/, "");
}

/**
 * Rendering puts a "## Detail" heading above a detail that starts with prose.
 * An entry that had no such heading keeps its layout: the intro prose moves
 * into the lede (the summary) so the detail starts at its first section.
 */
export function foldIntro(summary: string, detail: string, previous?: string): { summary: string; detail: string } {
  if (!previous || /^## Detail[ \t]*$/m.test(previous) || /^\s*#{1,6} /.test(detail)) return { summary, detail };
  const at = detail.search(/^#{1,6} /m);
  if (at <= 0) return { summary, detail }; // all prose, no sections: leave it to the renderer
  return { summary: `${summary.trim()}\n\n${detail.slice(0, at).trim()}`, detail: detail.slice(at) };
}

/** The relations in an entry's frontmatter (`relations:` and the legacy `related:`). */
export function existingRelations(markdown: string): Relation[] {
  const fm = /^---\n([\s\S]*?)\n---/.exec(markdown)?.[1];
  if (!fm) return [];
  let parsed: Record<string, unknown>;
  try {
    parsed = (yamlParse(fm) ?? {}) as Record<string, unknown>;
  } catch {
    return [];
  }
  const out: Relation[] = [];
  for (const raw of Array.isArray(parsed.relations) ? parsed.relations : []) {
    const r = Relation.safeParse(raw);
    if (r.success) out.push(r.data);
  }
  for (const raw of Array.isArray(parsed.related) ? parsed.related : []) {
    const o = raw as { rel?: unknown; kind?: unknown; target?: unknown };
    const r = Relation.safeParse({ kind: o.kind ?? o.rel, target: o.target, source: "code" });
    if (r.success) out.push(r.data);
  }
  return out;
}

/** Ids of the domain's entries that another entry supersedes (old decisions). */
export function supersededIds(roots: KbRoots, domain: string): Map<string, string> {
  const out = new Map<string, string>();
  const dir = entriesDir(roots, domain);
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
    const md = readFileSync(join(dir, f), "utf-8");
    if (!/supersedes/.test(md.slice(0, md.indexOf("\n---", 4) + 1 || 2000))) continue;
    for (const r of existingRelations(md)) {
      if (r.kind === "supersedes") out.set(r.target, f.replace(/\.md$/, ""));
    }
  }
  return out;
}

const WORK_CITATION = /\((work-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9A-Za-z]{7})\)\s*$/;

/**
 * Graduated work cites itself in its History lines "(work-<domain>-<id>)". The
 * model is asked to carry them into the entry but is not trusted to: any
 * History line of `contributionBody` whose work id the entry's History does not
 * cite yet is appended (a line the model already wrote for that work stands).
 */
export function addCitedHistory(detail: string, contributionBody: string): { detail: string; added: string[] } {
  const cited = bodyHistory(contributionBody).filter((l) => WORK_CITATION.test(l));
  if (cited.length === 0) return { detail, added: [] };
  const have = new Set(bodyHistory(detail).flatMap((l) => [...l.matchAll(/\bwork-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9A-Za-z]{7}\b/g)].map((m) => m[0])));
  const added = cited.filter((l) => !have.has(WORK_CITATION.exec(l)![1]));
  if (added.length === 0) return { detail, added };
  const base = detail.trimEnd();
  return {
    detail: HISTORY_HEADING.test(base) ? `${base}\n${added.join("\n")}\n` : `${base}\n\n## History\n\n${added.join("\n")}\n`,
    added,
  };
}
