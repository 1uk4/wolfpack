#!/usr/bin/env node
/**
 * normalize-kb — one-shot migration that re-serializes existing KB entry
 * frontmatter through the SAME deterministic renderer + guardrails the live
 * sweep now uses. Body content is never touched — only the `---` block is
 * rewritten (canonical key order, empty optionals dropped, link hygiene, date
 * sanity, type vocabulary).
 *
 * Usage:
 *   node scripts/normalize-kb.mjs            # dry run (default) — prints diffs
 *   node scripts/normalize-kb.mjs --apply    # write changes in place
 *   KB_BASE=/path node scripts/normalize-kb.mjs
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter, renderFrontmatter } from "@wolfpack/engine";
import { normalizeEntry } from "../dist/librarian/normalize.js";
import { renderDomainIndex } from "../dist/librarian/domains.js";

const APPLY = process.argv.includes("--apply");
const KB_BASE =
  process.env.KB_BASE ||
  join(process.env.HOME, "wolves", "knowledge", "base");
const DOMAINS_DIR = join(KB_BASE, "domains");

if (!existsSync(DOMAINS_DIR)) {
  console.error(`No domains dir at ${DOMAINS_DIR}`);
  process.exit(1);
}

/** Coerce raw parsed frontmatter into the shape normalizeEntry expects. */
function coerce(fields) {
  const arr = (v) =>
    Array.isArray(v) ? v : v === undefined || v === "" ? [] : [v];
  const str = (v) => (Array.isArray(v) ? (v[0] ?? "") : v);
  return {
    ...fields,
    subcategory: Array.isArray(fields.subcategory) ? "" : fields.subcategory,
    tag: Array.isArray(fields.tag) ? "" : fields.tag,
    expires: Array.isArray(fields.expires) ? undefined : fields.expires,
    asOf: Array.isArray(fields.asOf) ? undefined : fields.asOf,
    type: str(fields.type),
    related: arr(fields.related),
    supersedes: arr(fields.supersedes),
    sources: arr(fields.sources),
  };
}

// First pass: collect every real entry id so related/supersedes links can be
// checked for referential integrity (not just id shape).
const knownIds = new Set();
for (const domain of readdirSync(DOMAINS_DIR)) {
  const entriesDir = join(DOMAINS_DIR, domain, "entries");
  if (!existsSync(entriesDir)) continue;
  for (const file of readdirSync(entriesDir)) {
    if (file.endsWith(".md")) knownIds.add(file.replace(/\.md$/, ""));
  }
}

let changed = 0,
  total = 0,
  flagged = [];

for (const domain of readdirSync(DOMAINS_DIR)) {
  const entriesDir = join(DOMAINS_DIR, domain, "entries");
  if (!existsSync(entriesDir)) continue;
  for (const file of readdirSync(entriesDir)) {
    if (!file.endsWith(".md")) continue;
    total++;
    const path = join(entriesDir, file);
    const raw = readFileSync(path, "utf-8");
    const { fields, body } = parseFrontmatter(raw);
    const fm = coerce(fields);
    const { entry, warnings } = normalizeEntry({ frontmatter: fm }, domain, knownIds);
    const next = `${renderFrontmatter(entry.frontmatter)}\n${body}`;

    for (const w of warnings) flagged.push(`  ${file}: ${w}`);

    if (next !== raw) {
      changed++;
      console.log(`\n=== ${domain}/${file} ===`);
      // Show just the frontmatter block diff for readability.
      const oldFm = raw.split("\n---")[0];
      const newFm = next.split("\n---")[0];
      console.log("--- old ---\n" + oldFm);
      console.log("--- new ---\n" + newFm);
      if (APPLY) writeFileSync(path, next, "utf-8");
    }
  }
}

// Regenerate each domain's INDEX.md with navigable [[wikilinks]] (Obsidian).
if (APPLY) {
  const roots = { kbBase: KB_BASE };
  for (const domain of readdirSync(DOMAINS_DIR)) {
    if (existsSync(join(DOMAINS_DIR, domain, "entries"))) {
      renderDomainIndex(roots, domain);
    }
  }
  console.log("Regenerated domain INDEX.md files with [[wikilinks]].");
} else {
  console.log(
    "(INDEX.md files will be regenerated with [[wikilinks]] on --apply.)"
  );
}

console.log(
  `\n${APPLY ? "APPLIED" : "DRY RUN"}: ${changed}/${total} entries would change.`
);
if (flagged.length) {
  console.log(`\nGuardrail warnings (${flagged.length}):`);
  console.log(flagged.join("\n"));
}
if (!APPLY && changed) console.log("\nRe-run with --apply to write changes.");
