/**
 * nearestEntries — the entries of a domain closest to a piece of text, for the
 * wolf side (distill). Deterministic, no LLM and no embedder: a wolf cannot
 * count on Ollama, but every wolf has the KB mirror, so this is a lexical
 * TF-IDF cosine over the titles and summaries in the domain's INDEX.md.
 * Anchored entries (an initiative page) are left out, as they are in the sweep.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { entriesDir, type KbRoots } from "../shared/index.js";

export interface NearestEntry {
  id: string;
  title: string;
  summary: string;
  score: number;
}

const STOP = new Set(
  "the and for are was were with that this from into over under what when which who how why not but can has have had its our their they them then than also use used using only one two all any more most per via each other about after before between both should would could will may might onto out off".split(" ")
);

/** Lowercase word stems of 3+ letters, minus stop words. */
export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [])
    .filter((w) => !STOP.has(w))
    .map((w) => w.replace(/(?:ing|ed|es|s)$/, ""))
    .filter((w) => w.length >= 3);
}

interface Row {
  id: string;
  title: string;
  summary: string;
}

/** The rows of `domains/<domain>/INDEX.md`: `- [[id|title]] _(sub)_ — summary`. */
export function readIndexRows(roots: KbRoots, domain: string): Row[] {
  const file = join(roots.kbBase, "domains", domain, "INDEX.md");
  if (!existsSync(file)) return [];
  const rows: Row[] = [];
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    const m = /^- \[\[([^\]|]+)\|([^\]]*)\]\](?: _\([^)]*\)_)?(?: — (.*))?$/.exec(line);
    if (m) rows.push({ id: m[1], title: m[2], summary: (m[3] ?? "").trim() });
  }
  return rows;
}

const isAnchored = (roots: KbRoots, domain: string, id: string): boolean => {
  try {
    const md = readFileSync(join(entriesDir(roots, domain), `${id}.md`), "utf-8");
    return /^---\n[\s\S]*?^anchor:/m.test(md.slice(0, md.indexOf("\n---", 4) + 4));
  } catch {
    return false;
  }
};

export function nearestEntries(roots: KbRoots, domain: string, text: string, limit = 6): NearestEntry[] {
  const rows = readIndexRows(roots, domain);
  if (!rows.length) return [];
  const docs = rows.map((r) => [...tokens(r.title), ...tokens(r.title), ...tokens(r.summary)]);
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t: string) => Math.log(1 + rows.length / (1 + (df.get(t) ?? 0)));
  const vec = (ts: string[]) => {
    const v = new Map<string, number>();
    for (const t of ts) v.set(t, (v.get(t) ?? 0) + 1);
    for (const [t, n] of v) v.set(t, (1 + Math.log(n)) * idf(t));
    return v;
  };
  const norm = (v: Map<string, number>) => Math.sqrt([...v.values()].reduce((a, x) => a + x * x, 0)) || 1;
  const q = vec(tokens(text));
  const qn = norm(q);
  const scored = rows
    .map((r, i) => {
      const d = vec(docs[i]);
      let dot = 0;
      for (const [t, w] of q) dot += w * (d.get(t) ?? 0);
      return { ...r, score: dot / (qn * norm(d)) };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
  const out: NearestEntry[] = [];
  for (const r of scored) {
    if (out.length >= limit) break;
    if (isAnchored(roots, domain, r.id)) continue;
    out.push({ ...r, score: Number(r.score.toFixed(3)) });
  }
  return out;
}
