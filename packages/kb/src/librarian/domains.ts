/**
 * Declared-domain gate + per-domain INDEX generation (Dewey side).
 *
 * The CLI deploys the declared-domain set to <KB_BASE>/domains.yaml. The sweep
 * may ONLY commit entries into declared domains; anything else is quarantined
 * (see commit.quarantine) and surfaced as a recommendation. This keeps the KB
 * from growing an unmirrored, unreviewed domain behind your back.
 */
import { existsSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";
import { atomicWrite, parseFrontmatter } from "@wolfpack/engine";
import {
  type KbRoots,
  domainsRegistryFile,
  domainIndex,
  entriesDir,
} from "../shared/index.js";

/**
 * The declared domain names, or null when no registry is deployed (treated as
 * "unconstrained" for back-compat so a bare install still commits).
 */
export function readDeclaredDomains(roots: KbRoots): Set<string> | null {
  const file = domainsRegistryFile(roots);
  if (!existsSync(file)) return null;
  try {
    const parsed = (yamlParse(readFileSync(file, "utf-8")) ?? {}) as {
      domains?: Record<string, unknown>;
    };
    const names = Object.keys(parsed.domains ?? {});
    return new Set(names);
  } catch {
    return null;
  }
}

/** True when the domain is committable (declared, or no registry deployed). */
export function isDeclared(declared: Set<string> | null, domain: string): boolean {
  return declared === null || declared.has(domain);
}

/**
 * Regenerate `domains/<domain>/INDEX.md` from the entries on disk. Deterministic
 * (reads each entry's frontmatter). Call for each domain touched in a sweep.
 */
export function renderDomainIndex(roots: KbRoots, domain: string): void {
  const dir = entriesDir(roots, domain);
  const rows: Array<{ id: string; title: string; summary: string; sub: string }> = [];
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
      try {
        const { fields } = parseFrontmatter(readFileSync(join(dir, f), "utf-8"));
        rows.push({
          id: f.replace(/\.md$/, ""),
          title: String(fields.title ?? f.replace(/\.md$/, "")),
          summary: String(fields.summary ?? ""),
          sub: String(fields.subcategory ?? ""),
        });
      } catch {
        /* skip unreadable entry */
      }
    }
  }
  rows.sort((a, b) => a.title.localeCompare(b.title));

  const lines = [
    `# ${domain} — knowledge index`,
    "",
    `${rows.length} entr${rows.length === 1 ? "y" : "ies"}.`,
    "",
    ...rows.map(
      (r) => `- **${r.title}** ${r.sub ? `_(${r.sub})_ ` : ""}— ${r.summary} \`[${r.id}]\``,
    ),
    "",
  ];
  mkdirSync(dir, { recursive: true });
  atomicWrite(domainIndex(roots, domain), lines.join("\n"));
}
