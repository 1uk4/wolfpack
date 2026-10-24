/**
 * The content hash of an entry: its title, summary and detail joined by
 * newlines (Context is not part of it). produce computes it from the model's
 * opinion; entryHashOf recomputes it from a rendered entry file (commit.ts
 * renderEntry: H1, summary, an optional `## Detail` wrapper, detail, optional
 * `## Context`), so an edit made on the file keeps the hash produce would give.
 */
import { parseFrontmatter } from "@wolfpack/engine";
import { contentHash } from "../shared/hash.js";

export function entryHashText(title: string, summary: string, detail: string): string {
  return [title, summary, detail].join("\n");
}

/** Split a rendered entry's body into the parts produce hashed. */
export function entryPartsOf(md: string): { title: string; summary: string; detail: string } {
  const { fields, body } = parseFrontmatter(md);
  const title = String(fields.title ?? "");
  let rest = (/^\s*#[ \t]+[^\n]*\n+([\s\S]*)$/.exec(body)?.[1] ?? body).replace(/\s+$/, "");
  // renderEntry writes Context last; the last such heading is it.
  const ctx = rest.lastIndexOf("\n\n## Context\n\n");
  if (ctx >= 0) rest = rest.slice(0, ctx);
  // The summary runs to the first heading line (detail brings its own, or the Detail wrapper).
  const h = /^#{1,6} .*$/m.exec(rest);
  if (!h) return { title, summary: rest.trim(), detail: "" };
  const summary = rest.slice(0, h.index).trim();
  let detail = rest.slice(h.index);
  detail = detail.replace(/^## Detail[ \t]*\n+/, "");
  return { title, summary, detail: detail.trim() };
}

export function entryHashOf(md: string): string {
  const p = entryPartsOf(md);
  return contentHash(entryHashText(p.title, p.summary, p.detail));
}
