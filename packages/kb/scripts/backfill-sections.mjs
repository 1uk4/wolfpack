#!/usr/bin/env node
/**
 * backfill-sections — one-shot migration that builds the KB v2 hierarchical
 * SECTION TREE for a domain from its existing entries, using the SAME tested
 * clustering brain the live sweep uses (dist/librarian/hierarchy.js). It then
 * generates a section summary per node (the confined sectionSummary LLM call)
 * and stamps each entry's `section` into its frontmatter.
 *
 * Runs where the vectors + authority live (Dewey / sfo-01). Dry-run by default:
 * prints the proposed tree for REVIEW; --apply writes _sections.json, stamps
 * entries, and regenerates the domain digest.
 *
 * Usage:
 *   node scripts/backfill-sections.mjs                 # dry run — print proposed tree
 *   node scripts/backfill-sections.mjs --apply         # write _sections.json + stamp entries + digest
 *   BACKFILL_DOMAIN=wolfpack node scripts/backfill-sections.mjs
 *
 * Requires (same env as the sweep): KB_BASE, KB_OPS, ANTHROPIC_API_KEY, and an
 * embedder reachable at WOLFPACK_EMBED_URL (default ollama localhost:11434).
 *
 * Snapjack note: snapjack is deleted separately (it is re-crawled fresh). This
 * script refuses to run on snapjack; remove the domain manually:
 *   rm -rf "$KB_BASE/domains/snapjack"
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  parseFrontmatter,
  renderFrontmatter,
  createEngine,
  HIERARCHY,
} from "@wolfpack/engine";
import { computeCentroid, maybeSplit } from "../dist/librarian/hierarchy.js";
import { writeSections } from "../dist/librarian/sections.js";
import { sectionSummary, labelSection } from "../dist/librarian/summarize.js";
import { createEmbedder, embedInput } from "../dist/librarian/embed.js";
import { renderDomainDigest } from "../dist/librarian/domains.js";

const APPLY = process.argv.includes("--apply");
const DOMAIN = process.env.BACKFILL_DOMAIN || "wolfpack";

if (DOMAIN === "snapjack") {
  console.error("Refusing to backfill snapjack — it is re-crawled fresh. Delete it instead:");
  console.error(`  rm -rf "$KB_BASE/domains/snapjack"`);
  process.exit(1);
}

// ── roots (mirror cli.ts resolveRoots) ──────────────────────────────────────
const kbBase = process.env.KB_BASE;
const opsRoot = process.env.KB_OPS;
if (!kbBase || !opsRoot) {
  console.error("KB_BASE and KB_OPS are required (set in the wolf .env / sweep unit).");
  process.exit(1);
}
const denRoot = process.env.WOLF_DEN ?? join(homedir(), "wolves", "den");
const roots = {
  kbBase: resolve(kbBase),
  opsRoot: resolve(opsRoot),
  denLocal: resolve(process.env.KB_DEN_LOCAL ?? join(denRoot, "kb")),
};

const entriesDir = join(roots.kbBase, "domains", DOMAIN, "entries");
if (!existsSync(entriesDir)) {
  console.error(`No entries dir at ${entriesDir}`);
  process.exit(1);
}

// ── engine (mirror cli.ts makeEngine) ───────────────────────────────────────
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY is required");
  process.exit(1);
}
const defaultModel = process.env.WOLFPACK_MODEL ?? "claude-sonnet-4-6";
const fastModel = process.env.WOLFPACK_FAST_MODEL ?? "claude-haiku-4-5-20251001";
const engine = createEngine({
  provider: "anthropic",
  apiKey,
  defaultModel,
  steps: { sectionSummary: { model: fastModel }, labelSection: { model: fastModel } },
});
const embedder = createEmbedder(roots);

function mkSectionId(domain) {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let tail = "";
  for (let i = 0; i < 6; i++) tail += chars[Math.floor(Math.random() * chars.length)];
  return `sec-${domain}-${tail}`;
}
const nowIso = () => new Date().toISOString().slice(0, 10);

// ── 1. read + embed entries ─────────────────────────────────────────────────
console.log(`\nReading ${DOMAIN} entries from ${entriesDir} …`);
const entries = [];
for (const file of readdirSync(entriesDir)) {
  if (!file.endsWith(".md")) continue;
  const path = join(entriesDir, file);
  const raw = readFileSync(path, "utf-8");
  const { fields, body } = parseFrontmatter(raw);
  const id = String(fields.id ?? file.replace(/\.md$/, ""));
  entries.push({ id, path, raw, fields, body });
}
console.log(`Found ${entries.length} entries. Embedding …`);

const members = [];
for (const e of entries) {
  const text = embedInput({ summary: String(e.fields.summary ?? ""), detail: e.body });
  const vector = await embedder.embed(text, String(e.fields.contentHash ?? e.id));
  members.push({ entryId: e.id, sectionId: null, vector });
}

// ── 2. build the tree (recursive binary split, reusing hierarchy.maybeSplit) ─
const allSections = [];
const entryToSection = new Map();

function buildSubtree(section, mbrs, depth) {
  allSections.push(section);
  const split = depth >= HIERARCHY.maxDepth ? null : maybeSplit(section, mbrs);
  if (!split || split.children.length < 2) {
    // leaf
    section.childIds = [];
    section.memberCount = mbrs.length;
    for (const m of mbrs) entryToSection.set(m.entryId, section.id);
    return;
  }
  section.childIds = split.children.map((c) => c.id);
  section.memberCount = 0; // internal node; entries live at leaves
  for (const child of split.children) {
    const childMembers = mbrs.filter((m) => split.reassignment.get(m.entryId) === child.id);
    buildSubtree(child, childMembers, depth + 1);
  }
}

const root = {
  id: mkSectionId(DOMAIN),
  domain: DOMAIN,
  parent: null,
  depth: 0,
  label: DOMAIN,
  title: `${DOMAIN} (root)`,
  centroid: computeCentroid(members.map((m) => m.vector)),
  memberCount: members.length,
  childIds: [],
  summary: "",
  summaryHash: "",
  dirty: true,
  created: nowIso(),
  updated: nowIso(),
};
buildSubtree(root, members, 0);

// ── 3. summaries (post-order; confined sectionSummary LLM call) ──────────────
const byId = new Map(allSections.map((s) => [s.id, s]));
const titleOf = new Map(entries.map((e) => [e.id, String(e.fields.title ?? e.id)]));
const membersBySection = new Map();
for (const [entryId, secId] of entryToSection) {
  if (!membersBySection.has(secId)) membersBySection.set(secId, []);
  membersBySection.get(secId).push(entryId);
}

async function summarizeSection(section) {
  let childSummaries;
  if (section.childIds.length > 0) {
    for (const cid of section.childIds) await summarizeSection(byId.get(cid));
    childSummaries = section.childIds.map((cid) => byId.get(cid).summary);
  } else {
    childSummaries = (membersBySection.get(section.id) ?? []).map((eid) => titleOf.get(eid));
  }
  section.summary = childSummaries.length
    ? await sectionSummary(engine, childSummaries)
    : "(empty section)";
  section.dirty = false;
}

// Pre-order labeling: each node sees its parent title + sibling summaries, so
// titles come out distinct across levels and across siblings.
async function labelNode(section, parentTitle, siblingSummaries) {
  const isLeaf = section.childIds.length === 0;
  const sampleTitles = isLeaf
    ? (membersBySection.get(section.id) ?? []).map((eid) => titleOf.get(eid))
    : [];
  section.title = await labelSection(engine, section.summary, {
    parentTitle,
    siblingSummaries,
    sampleTitles,
  });
  if (!isLeaf) {
    const children = section.childIds.map((cid) => byId.get(cid));
    for (const child of children) {
      const sibs = children.filter((c) => c.id !== child.id).map((c) => c.summary);
      await labelNode(child, section.title, sibs);
    }
  }
}
console.log("Generating section summaries …");
await summarizeSection(root);
console.log("Labeling sections …");
await labelNode(root, undefined, []);

// ── 4. report ────────────────────────────────────────────────────────────────
console.log(`\n=== Proposed section tree for "${DOMAIN}" (${allSections.length} sections) ===`);
function printTree(section, indent = "") {
  const n = section.childIds.length ? "" : ` [${section.memberCount} entries]`;
  console.log(`${indent}${section.id}  "${section.title}"${n}`);
  console.log(`${indent}    ↳ ${section.summary}`);
  for (const cid of section.childIds) printTree(byId.get(cid), indent + "  ");
}
printTree(root);

// ── 5. apply ─────────────────────────────────────────────────────────────────
if (!APPLY) {
  console.log(`\nDRY RUN: ${entries.length} entries → ${allSections.length} sections. Nothing written.`);
  console.log("Review the tree above, then re-run with --apply.");
  process.exit(0);
}

console.log("\nAPPLYING …");
writeSections(roots, allSections);
let stamped = 0;
for (const e of entries) {
  const section = entryToSection.get(e.id);
  if (!section) continue;
  const fields = { ...e.fields, section };
  const next = `${renderFrontmatter(fields)}\n${e.body}`;
  writeFileSync(e.path, next, "utf-8");
  stamped++;
}
renderDomainDigest(roots, DOMAIN);
console.log(`APPLIED: wrote _sections.json (${allSections.length} sections), stamped ${stamped} entries, regenerated digest.`);
console.log("Review + commit:  git -C \"$KB_BASE\" add -A && git -C \"$KB_BASE\" commit -m 'kb v2: backfill wolfpack section tree'");
