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

// ── No duplicate content on merge ───────────────────────────────────────────

/** Near-duplicate threshold on normalized text (word-bigram Dice). */
export const DUPLICATE_SIMILARITY = 0.9;

const words = (s: string): string[] => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean);

/** Word-bigram Dice similarity of two texts after normalization, 0..1. */
export function textSimilarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.join(" ") === wb.join(" ")) return wa.length ? 1 : 0;
  const grams = (w: string[]) => {
    const m = new Map<string, number>();
    for (let i = 0; i + 1 < w.length; i++) m.set(`${w[i]} ${w[i + 1]}`, (m.get(`${w[i]} ${w[i + 1]}`) ?? 0) + 1);
    return m;
  };
  const ga = grams(wa);
  const gb = grams(wb);
  let total = 0;
  let common = 0;
  for (const n of ga.values()) total += n;
  for (const n of gb.values()) total += n;
  if (total === 0) return 0;
  for (const [g, n] of ga) common += Math.min(n, gb.get(g) ?? 0);
  return (2 * common) / total;
}

/** Shorter texts (bullets like "- none") are never collapsed. */
const MIN_WORDS = 6;
const isDup = (a: string, b: string) =>
  words(a).length >= MIN_WORDS && words(b).length >= MIN_WORDS && textSimilarity(a, b) >= DUPLICATE_SIMILARITY;

const CITATION = /\((work-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9A-Za-z]{7})\)\s*\.?\s*$/;

type Unit = { text: string; lines: string[]; kind: "heading" | "code" | "bullet" | "para" | "blank"; dropped?: boolean };

/** A body as units: headings, fenced blocks, bullets (with their indented continuation), paragraphs and blank lines. */
function detailUnits(main: string): Unit[] {
  const units: Unit[] = [];
  const lines = main.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*```/.test(l)) {
      const block = [l];
      while (++i < lines.length) {
        block.push(lines[i]);
        if (/^\s*```/.test(lines[i])) break;
      }
      units.push({ text: "", lines: block, kind: "code" });
    } else if (!l.trim()) units.push({ text: "", lines: [l], kind: "blank" });
    else if (/^#{1,6} /.test(l)) units.push({ text: l, lines: [l], kind: "heading" });
    else if (/^\s*(?:[-*]|\d+\.)\s/.test(l)) {
      const block = [l];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && !/^\s*(?:[-*]|\d+\.)\s/.test(lines[i + 1])) block.push(lines[++i]);
      units.push({ text: block.join(" "), lines: block, kind: "bullet" });
    } else {
      const block = [l];
      while (i + 1 < lines.length && lines[i + 1].trim() && !/^(?:#{1,6} |\s*(?:[-*]|\d+\.)\s|\s*```)/.test(lines[i + 1])) block.push(lines[++i]);
      units.push({ text: block.join(" "), lines: block, kind: "para" });
    }
  }
  return units;
}

/**
 * Collapse near-duplicate paragraphs and bullets of a merged entry (first one
 * wins; a heading left empty by it goes too) and History lines that restate
 * the same change (same closing work id and the same fact, or near-identical
 * text). `keep` lines (the previous entry's History) are never dropped.
 * `against` seeds the comparison with text that lives elsewhere (a split-out
 * subject), so a copy of it left in the entry is dropped too.
 */
export function dedupeDetail(detail: string, keep: ReadonlySet<string> = new Set(), against = ""): { detail: string; removed: string[] } {
  const at = detail.search(HISTORY_HEADING);
  const main = at < 0 ? detail : detail.slice(0, at);
  const history = at < 0 ? "" : detail.slice(at);
  const removed: string[] = [];

  const units = detailUnits(main);
  // `against`: text that lives elsewhere now (a split-out second subject); what repeats it is dropped here.
  const seen: string[] = detailUnits(against).filter((u) => u.kind === "bullet" || u.kind === "para").map((u) => u.text);
  let dirtyUnder = false;
  const heads: Array<{ unit: Unit; level: number; dirty: boolean }> = [];
  for (const u of units) {
    if (u.kind === "heading") {
      heads.push({ unit: u, level: /^#+/.exec(u.text)![0].length, dirty: false });
      continue;
    }
    if (u.kind !== "bullet" && u.kind !== "para") continue;
    if (seen.some((s) => isDup(s, u.text))) {
      u.dropped = true;
      removed.push(u.text.trim());
      if (heads.length) heads[heads.length - 1].dirty = true;
      dirtyUnder = true;
    } else seen.push(u.text);
  }
  if (!removed.length) dirtyUnder = false;
  if (dirtyUnder) {
    // An emptied section goes too: a dirty heading with nothing kept before the next heading of its level or above.
    for (let h = 0; h < heads.length; h++) {
      if (!heads[h].dirty) continue;
      const from = units.indexOf(heads[h].unit) + 1;
      let empty = true;
      for (let i = from; i < units.length; i++) {
        const u = units[i];
        if (u.kind === "heading" && /^#+/.exec(u.text)![0].length <= heads[h].level) break;
        if (u.kind !== "blank" && !u.dropped) { empty = false; break; }
      }
      if (empty) heads[h].unit.dropped = true;
    }
  }
  const keptMain = units.filter((u) => !u.dropped).flatMap((u) => u.lines).join("\n").replace(/\n{3,}/g, "\n\n");

  // History: a line restating a change already recorded.
  let keptHistory = history;
  if (history) {
    const kept: string[] = [];
    const out = history.split("\n").filter((l) => {
      if (!l.trim().startsWith("- ")) return true;
      const cite = CITATION.exec(l.trim())?.[1];
      const body = l.replace(CITATION, "");
      const dup = kept.some((k) => {
        const kc = CITATION.exec(k.trim())?.[1];
        const kb = k.replace(CITATION, "");
        return textSimilarity(kb, body) >= DUPLICATE_SIMILARITY || (!!cite && cite === kc && textSimilarity(kb, body) >= 0.7);
      });
      if (dup && !keep.has(norm(l))) {
        removed.push(l.trim());
        return false;
      }
      kept.push(l);
      return true;
    });
    keptHistory = out.join("\n");
  }
  return { detail: `${keptMain}${keptHistory}`, removed };
}
