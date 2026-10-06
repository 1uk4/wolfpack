/**
 * resolve — read a full KB entry from the wolf's local kb-base mirror.
 * Point-of-need resolution; Syncthing keeps the mirror fresh.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@wolfpack/engine";
import { entriesDir, type KbRoots } from "../shared/index.js";

export interface ResolvedEntry {
  id: string;
  title: string;
  body: string;
  fields: Record<string, unknown>;
  filePath: string;
}

/** Resolve an entry by id within a domain. Returns null if not mirrored yet. */
export function resolveEntry(
  roots: KbRoots,
  domain: string,
  id: string
): ResolvedEntry | null {
  const dir = entriesDir(roots, domain);
  const path = join(dir, `${id}.md`);
  if (!existsSync(path)) return null;
  const { fields, body } = parseFrontmatter(readFileSync(path, "utf-8"));
  return { id, title: String(fields.title ?? id), body, fields, filePath: path };
}

/** List entry ids available in a domain's mirror (for discovery/scan). */
export function listEntries(roots: KbRoots, domain: string): string[] {
  const dir = entriesDir(roots, domain);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));
}
