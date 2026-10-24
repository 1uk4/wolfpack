/**
 * split-fat — admin op for splitting oversized KB entries into cohesive shards.
 *
 * A single bloated entry (crawl grab-bag, or legacy pre-cap import) blocks the
 * sweep's merge path (size guard refuses to merge into it) and clutters the
 * section tree. This tool proposes a shard split along natural H2/H3 boundaries
 * via the engine, writes the new entries inheriting the parent's frontmatter,
 * then retires the original through the normal `retireEntries` path.
 *
 * Operates on ANY domain (unlike the one-off scripts): the caller passes a
 * domain name and the id prefix is derived from it. The shards are placed as
 * siblings in the parent's section; a follow-up `kb_reorg` re-routes them
 * into the right branch of the tree.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Engine } from "@wolfpack/engine";
import { atomicWrite, parseFrontmatter } from "@wolfpack/engine";
import { entriesDir, ev, type KbRoots } from "../shared/index.js";
import { SectionId } from "../schema/knowledge.js";
import { retireEntries } from "./retire.js";
import { anchorOf } from "./anchors.js";
import { appendLedger } from "./ledger.js";
import { withKbLock } from "./lock.js";

// ── Tunables ──────────────────────────────────────────────────────────────
export const SPLIT_FAT = {
  /** Minimum entry size (chars) considered oversized. */
  oversizedThreshold: 10_000,
  /** Per-shard target the LLM aims for. */
  targetShardMax: 6_000,
  /** Divisor for shard-count heuristic: shards = max(2, round(size / X)). */
  shardSizeDivisor: 7_500,
  /** Hard upper bound on shards per split. */
  maxShards: 8,
} as const;

// ── Public types ──────────────────────────────────────────────────────────
export interface FatCandidate {
  entryId: string;
  domain: string;
  size: number;
  title: string;
  nH2Sections: number;
  suggestedShards: number;
}

export interface SplitFatResult {
  entryId: string;
  parentSize: number;
  shards: Array<{ entryId: string; title: string; size: number }>;
  retired: boolean;
}

// ── Scan ──────────────────────────────────────────────────────────────────
/**
 * Enumerate oversized entries in one domain (or all under kbBase/domains if
 * `domain` is omitted). Pure read, no mutation.
 */
export function scanFat(
  roots: KbRoots,
  opts: { domain?: string; threshold?: number } = {}
): FatCandidate[] {
  const threshold = opts.threshold ?? SPLIT_FAT.oversizedThreshold;
  const domains = opts.domain ? [opts.domain] : listDomains(roots);
  const out: FatCandidate[] = [];

  for (const domain of domains) {
    const dir = entriesDir(roots, domain);
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const f of files) {
      const path = join(dir, f);
      let size = 0;
      try {
        size = statSync(path).size;
      } catch {
        continue;
      }
      if (size < threshold) continue;
      const raw = readFileSync(path, "utf-8");
      if (anchorOf(raw)) continue; // anchored entries are pinned records, never split
      const title = extractTitle(raw) ?? f.replace(/\.md$/, "");
      const nH2 = (raw.match(/^## /gm) ?? []).length;
      out.push({
        entryId: f.replace(/\.md$/, ""),
        domain,
        size,
        title,
        nH2Sections: nH2,
        suggestedShards: suggestShardCount(size),
      });
    }
  }
  out.sort((a, b) => b.size - a.size);
  return out;
}

function listDomains(roots: KbRoots): string[] {
  const base = join(roots.kbBase, "domains");
  try {
    return readdirSync(base).filter((d) => {
      try {
        return statSync(join(base, d)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function extractTitle(raw: string): string | null {
  const m = raw.match(/^title:\s*"?([^"\n]+?)"?\s*$/m);
  return m ? m[1].trim() : null;
}

function suggestShardCount(size: number): number {
  const n = Math.max(2, Math.round(size / SPLIT_FAT.shardSizeDivisor));
  return Math.min(n, SPLIT_FAT.maxShards);
}

// ── LLM shard proposal ────────────────────────────────────────────────────
const ShardProposalSchema = z.object({
  shards: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        summary: z.string().min(1).max(180),
        body: z.string().min(1).max(SPLIT_FAT.targetShardMax * 2),
      })
    )
    .min(2)
    .max(SPLIT_FAT.maxShards),
});
type ShardProposal = z.infer<typeof ShardProposalSchema>;

function splitSystemPrompt(nShards: number): string {
  return `You are splitting an oversized KB entry into ${nShards} smaller sibling entries.

RULES:
- Split along natural ## header boundaries. Preserve content verbatim; do not editorialize.
- Each shard is a cohesive subtheme that stands alone and that an LLM can distinguish from the others.
- Target each shard body under ${SPLIT_FAT.targetShardMax} chars.
- Shard titles are distinct and specific (never generic like "Part 1").
- 1-sentence summaries per shard — the load-bearing index line.
- Content distribution: no overlap; every ## section from the parent goes to exactly ONE shard.
- If the parent has an intro paragraph before the first ##, duplicate it into each shard so each stands alone.

Respond with JSON matching the schema.`;
}

async function proposeShards(
  engine: Engine,
  parentTitle: string,
  parentBody: string,
  nShards: number
): Promise<ShardProposal> {
  const prompt = `Parent title: ${parentTitle}

Parent body (${parentBody.length} chars):
---
${parentBody}
---

Propose ${nShards} shards. Return JSON.`;
  return engine.call("consolidate", ShardProposalSchema, {
    system: splitSystemPrompt(nShards),
    prompt,
  });
}

// ── Frontmatter rewrite ───────────────────────────────────────────────────
/**
 * Split a raw entry file into (yaml, body) at the frontmatter boundary.
 */
function parseEntryFile(raw: string): { yaml: string; body: string } {
  if (!raw.startsWith("---\n")) {
    throw new Error("entry has no frontmatter opener");
  }
  const close = raw.indexOf("\n---\n", 4);
  if (close < 0) throw new Error("entry has no frontmatter closer");
  return { yaml: raw.slice(4, close), body: raw.slice(close + 5) };
}

function yamlQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Rewrite the parent's YAML frontmatter for a child shard: swap id/title/
 * summary/dates/contentHash, drop section + placement + properties (reorg will
 * repaint them), and inject see_also relations to the sibling shards.
 *
 * Operates on the raw YAML string line-by-line so nested blocks round-trip
 * cleanly (the lightweight parseFrontmatter would flatten them).
 */
function rewriteShardFrontmatter(
  parentYaml: string,
  shardId: string,
  shardTitle: string,
  shardSummary: string,
  bodyHash: string,
  siblingIds: string[]
): string {
  const lines = parentYaml.split("\n");
  const out: string[] = [];
  const dropBlocks = new Set(["section", "placement", "anchor", "properties", "relations", "related", "see_also"]);
  let skipIndentBlock = false;

  for (const line of lines) {
    if (skipIndentBlock) {
      if (/^\s/.test(line) && line.trim() !== "") continue;
      skipIndentBlock = false;
    }

    const colon = line.indexOf(":");
    const key = colon > 0 && !/^\s/.test(line) ? line.slice(0, colon).trim() : "";

    if (!key) {
      out.push(line);
      continue;
    }

    if (dropBlocks.has(key)) {
      // Drop the top-level key; if its value is empty, also drop the indented block.
      const value = line.slice(colon + 1).trim();
      if (value === "") skipIndentBlock = true;
      continue;
    }

    switch (key) {
      case "id":
        out.push(`id: ${shardId}`);
        break;
      case "title":
        out.push(`title: ${yamlQuote(shardTitle)}`);
        break;
      case "summary":
        out.push(`summary: ${yamlQuote(shardSummary)}`);
        break;
      case "created":
        out.push(`created: ${todayISO()}`);
        break;
      case "updated":
        out.push(`updated: ${todayISO()}`);
        break;
      case "contentHash":
        out.push(`contentHash: sha256:${bodyHash}`);
        break;
      default:
        out.push(line);
    }
  }

  if (!out.some((l) => l.startsWith("summary:"))) {
    out.push(`summary: ${yamlQuote(shardSummary)}`);
  }

  if (siblingIds.length > 0) {
    out.push("relations:");
    for (const sid of siblingIds) {
      out.push("  - kind: see_also");
      out.push(`    target: ${sid}`);
      out.push("    source: split-fat");
    }
  }

  return out.join("\n");
}

function makeEntryId(domain: string): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = randomBytes(7);
  let suffix = "";
  for (let i = 0; i < 7; i++) suffix += chars[bytes[i] % chars.length];
  return `kb-${domain}-${suffix}`;
}

// ── Split one ─────────────────────────────────────────────────────────────
export interface SplitFatOptions {
  engine: Engine;
  roots: KbRoots;
  entryId: string;
  threshold?: number;
  notify?: (msg: string) => void;
  /** When true, propose + report shards but do not write or retire. */
  dryRun?: boolean;
}

export async function splitFatEntry(opts: SplitFatOptions): Promise<SplitFatResult> {
  const { engine, roots, entryId, notify } = opts;
  const threshold = opts.threshold ?? SPLIT_FAT.oversizedThreshold;
  const domain = entryId.split("-")[1];
  if (!domain) throw new Error(`invalid entry id: ${entryId}`);
  const file = join(entriesDir(roots, domain), `${entryId}.md`);

  const raw = readFileSync(file, "utf-8");
  const { yaml, body } = parseEntryFile(raw);
  if (/^anchor:/m.test(yaml)) throw new Error(`${entryId} is anchored: an anchored entry is a pinned record and is not split`);
  if (raw.length < threshold) {
    return { entryId, parentSize: raw.length, shards: [], retired: false };
  }

  const title = extractTitle(raw) ?? entryId;
  const nShards = suggestShardCount(raw.length);
  notify?.(`[split-fat] ${entryId} (${raw.length} chars) → proposing ${nShards} shards`);

  const proposal = await proposeShards(engine, title, body, nShards);
  const shards = proposal.shards;
  notify?.(`[split-fat] ${entryId}: LLM returned ${shards.length} shards`);

  // Pre-allocate ids so each shard carries its siblings in see_also relations.
  const shardIds = shards.map(() => makeEntryId(domain));
  const written: SplitFatResult["shards"] = [];

  if (opts.dryRun) {
    for (let i = 0; i < shards.length; i++) {
      written.push({ entryId: shardIds[i], title: shards[i].title, size: shards[i].body.length });
    }
    return { entryId, parentSize: raw.length, shards: written, retired: false };
  }

  // Shards inherit the parent's section in the ledger (their files drop it;
  // a reorg repaints both).
  const parentSection = String(parseFrontmatter(raw).fields.section ?? "");

  // Hold the KB lock so a sweep can't interleave with the writes and the
  // retirement. Each shard's ledger events follow its file immediately, as in
  // the sweep, so a crash can't leave a live shard with no ledger record.
  const retired = await withKbLock(roots, async () => {
    for (let i = 0; i < shards.length; i++) {
      const shard = shards[i];
      const shardId = shardIds[i];
      const siblings = shardIds.filter((_, j) => j !== i);
      const bodyHash = createHash("sha256").update(shard.body).digest("hex");
      const newYaml = rewriteShardFrontmatter(
        yaml,
        shardId,
        shard.title,
        shard.summary,
        bodyHash,
        siblings
      );
      const content = `---\n${newYaml}\n---\n\n${shard.body.replace(/\s+$/, "")}\n`;
      atomicWrite(join(entriesDir(roots, domain), `${shardId}.md`), content);
      appendLedger(roots, [
        ev.entryWritten(shardId, shardId, "create"),
        ...(SectionId.safeParse(parentSection).success
          ? [ev.entryPlaced({ entryId: shardId, sectionId: parentSection, basis: "routed", fit: 1 })]
          : []),
      ]);
      written.push({ entryId: shardId, title: shard.title, size: shard.body.length });
      notify?.(`[split-fat] ${entryId}: wrote ${shardId} (${shard.body.length} chars)`);
    }

    const retire = retireEntries(roots, [entryId], {
      reason: `split into ${shardIds.join(",")}`,
    });
    const ok = retire.retired.length > 0;
    notify?.(`[split-fat] ${entryId}: ${ok ? "retired" : "retire failed"}`);
    return ok;
  }, { waitMs: 15 * 60_000 });

  return { entryId, parentSize: raw.length, shards: written, retired };
}

// ── Auto ──────────────────────────────────────────────────────────────────
export interface SplitFatAutoOptions {
  engine: Engine;
  roots: KbRoots;
  domain?: string;
  threshold?: number;
  /** Max entries to process in one call. */
  max?: number;
  notify?: (msg: string) => void;
  dryRun?: boolean;
}

export async function splitFatAuto(
  opts: SplitFatAutoOptions
): Promise<{ scanned: FatCandidate[]; processed: SplitFatResult[] }> {
  const scanned = scanFat(opts.roots, { domain: opts.domain, threshold: opts.threshold });
  const take = opts.max && opts.max > 0 ? scanned.slice(0, opts.max) : scanned;
  const total = take.length;
  const notify = opts.notify;
  const dryTag = opts.dryRun ? " (dry-run)" : "";

  if (total === 0) {
    notify?.(`[split-fat] no oversized entries${opts.domain ? ` in ${opts.domain}` : ""}`);
    return { scanned, processed: [] };
  }

  const totalInputChars = take.reduce((n, c) => n + c.size, 0);
  notify?.(
    `[split-fat] plan${dryTag}: ${total} entr${total === 1 ? "y" : "ies"} · ${totalInputChars.toLocaleString()} chars total ` +
      `· expected ~${take.reduce((n, c) => n + c.suggestedShards, 0)} shards`
  );

  const processed: SplitFatResult[] = [];
  const started = Date.now();
  let shardsWritten = 0;
  let charsReduced = 0;

  for (let i = 0; i < take.length; i++) {
    const c = take[i];
    const pos = `[${i + 1}/${total}]`;
    notify?.(
      `[split-fat] ${pos} starting ${c.entryId} (${c.size.toLocaleString()} chars, ~${c.suggestedShards} shards)`
    );
    const entryStart = Date.now();

    let r: SplitFatResult;
    try {
      r = await splitFatEntry({
        engine: opts.engine,
        roots: opts.roots,
        entryId: c.entryId,
        threshold: opts.threshold,
        notify,
        dryRun: opts.dryRun,
      });
    } catch (err) {
      notify?.(
        `[split-fat] ${pos} FAILED ${c.entryId}: ${err instanceof Error ? err.message : String(err)}`
      );
      processed.push({ entryId: c.entryId, parentSize: c.size, shards: [], retired: false });
      continue;
    }

    processed.push(r);
    shardsWritten += r.shards.length;
    const shardChars = r.shards.reduce((n, s) => n + s.size, 0);
    if (!opts.dryRun && r.retired) charsReduced += r.parentSize - shardChars;

    const remaining = total - (i + 1);
    const elapsedS = Math.round((Date.now() - entryStart) / 1000);
    const etaS = remaining > 0
      ? Math.round(((Date.now() - started) / (i + 1)) * remaining / 1000)
      : 0;
    notify?.(
      `[split-fat] ${pos} done ${c.entryId} → ${r.shards.length} shards ` +
        `(${elapsedS}s) · remaining ${remaining}` +
        (remaining > 0 ? ` · ETA ~${Math.round(etaS / 60)}m` : "")
    );
  }

  const totalS = Math.round((Date.now() - started) / 1000);
  notify?.(
    `[split-fat] complete${dryTag}: ${processed.length} parent(s) → ${shardsWritten} shard(s) ` +
      (opts.dryRun ? "" : `· reclaimed ${charsReduced.toLocaleString()} chars `) +
      `in ${Math.round(totalS / 60)}m${totalS % 60}s`
  );

  return { scanned, processed };
}
