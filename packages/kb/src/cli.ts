#!/usr/bin/env node
/**
 * wolfpack-kb — Dewey's KB engine CLI. Driven by a systemd timer (see
 * infra/roles/kb-sweep) so sweeps run whether or not Dewey is mid-conversation.
 *
 * Commands:
 *   status            read-only health + consistency dashboard (no writes):
 *                     sweep lock, inbox backlog, and file↔ledger drift per
 *                     domain. Start here when something looks off.
 *   sweep [--drain]   route → produce → commit → fan-out. One batch per run
 *                     (for the timer); add --drain to loop until the inbox is
 *                     empty or a pass makes no progress (manual/dev use).
 *   rebuild-vectors   wipe + re-embed the entry-vector cache (model change etc.)
 *
 * A den-local lock (sweep.lock) guarantees a single writer — a second sweep
 * refuses rather than racing (stale locks are auto-reclaimed).
 *
 * Environment:
 *   WOLFPACK_KB_PROVIDER  — "claude-agent-sdk" (default; Claude subscription
 *                           bridge, no API key) or "anthropic" (ANTHROPIC_API_KEY)
 *   ANTHROPIC_API_KEY     — required only when WOLFPACK_KB_PROVIDER=anthropic
 *   WOLFPACK_MODEL        — smart model for produce (default: sonnet-4-5 bridge / sonnet-4-6 api)
 *   WOLFPACK_FAST_MODEL   — fast model for oracles (default: haiku-4-5 bridge / dated on api)
 *   KB_BASE               — knowledge/base root (default: ~/knowledge/base)
 *   KB_OPS                — librarian-ops root (default: ~/librarian)
 *   WOLF_DEN              — den root; den-local KB state lives at $WOLF_DEN/kb
 *   WOLFPACK_EMBED_URL    — Ollama URL (default: http://127.0.0.1:11434)
 *   WOLFPACK_EMBED_MODEL  — embedding model (default: nomic-embed-text)
 */
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import {
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { createEngine } from "@wolfpack/engine";
import type { KbRoots } from "./shared/index.js";
import {
  vectorsDir,
  entriesDir,
  domainRegistryFile,
  unclassifiedDir,
  ledgerFile,
} from "./shared/index.js";
import {
  sweep,
  readLedger,
  appendLedger,
  foldRegistry,
  renderRegistry,
  renderDomainIndex,
  createEmbedder,
  buildEntryVectors,
  cosine,
} from "./librarian/index.js";
import { readSections, writeSections } from "./librarian/sections.js";
import {
  maybeSplit,
  shouldMerge,
  crystallizeUnplaced,
  type EntryWithVector,
} from "./librarian/hierarchy.js";
import { renderDomainDigest } from "./librarian/domains.js";
import { labelSection, sectionSummary, type SectionMember } from "./librarian/summarize.js";
import { retireEntries } from "./librarian/retire.js";
import { ev, type KbEvent } from "./shared/index.js";
import type { Section, SectionId, DomainId } from "./schema/knowledge.js";
import { parseFrontmatter } from "@wolfpack/engine";

function resolveRoots(): KbRoots {
  const home = homedir();
  const denRoot = process.env.WOLF_DEN ?? join(home, "wolves", "den");
  // KB_BASE/KB_OPS MUST be explicit. The librarian writes curated entries to
  // KB_BASE and wolves read from the same mirror \u2014 a wrong default here is
  // exactly the drift that silently stranded 29 committed entries (sweep wrote
  // ~/knowledge/base while wolves read ~/wolves/knowledge/base). Fail loudly
  // rather than diverge.
  const kbBase = process.env.KB_BASE;
  const opsRoot = process.env.KB_OPS;
  if (!kbBase || !opsRoot) {
    console.error(
      "KB_BASE and KB_OPS are required (set in the wolf .env / sweep unit). " +
        "Refusing to run against ambiguous default paths."
    );
    process.exit(1);
  }
  return {
    kbBase: resolve(kbBase),
    opsRoot: resolve(opsRoot),
    // den-local KB state (ledger/vectors). Overridable so it can live outside
    // the (user-owned, synced) den when the sweep runs as root.
    denLocal: resolve(process.env.KB_DEN_LOCAL ?? join(denRoot, "kb")),
  };
}

function makeEngine() {
  // Transport. Default to the Claude Agent SDK bridge (user's Claude
  // subscription via the local `claude` binary) so sweeps don't need an API key.
  // On wolf-01 / systemd where the subscription OAuth isn't available, set
  // WOLFPACK_KB_PROVIDER=anthropic to use ANTHROPIC_API_KEY instead.
  const provider = (process.env.WOLFPACK_KB_PROVIDER ?? "claude-agent-sdk").toLowerCase();
  const useBridge = provider === "claude-agent-sdk" || provider === "claude-bridge";
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!useBridge && !apiKey) {
    console.error(
      "ANTHROPIC_API_KEY is required (or set WOLFPACK_KB_PROVIDER=claude-agent-sdk " +
        "to use the Claude subscription bridge)"
    );
    process.exit(1);
  }
  // The bridge speaks Claude Code model aliases (undated); the API path wants
  // dated ids. Pick defaults to match whichever transport is active.
  const defaultModel =
    process.env.WOLFPACK_MODEL ?? (useBridge ? "claude-sonnet-4-5" : "claude-sonnet-4-6");
  const fastModel =
    process.env.WOLFPACK_FAST_MODEL ?? (useBridge ? "claude-haiku-4-5" : "claude-haiku-4-5-20251001");
  // Bound a single hanging call (anthropic path only; the bridge has no API
  // timeout and ignores this). Default 10m is generous enough for a large
  // 16k-token produce but still caps a wedged request. Tunable per run.
  const requestTimeoutMs =
    Number(process.env.WOLFPACK_REQUEST_TIMEOUT_MS) || 600_000;
  return createEngine({
    provider: useBridge ? "claude-agent-sdk" : "anthropic",
    ...(useBridge ? {} : { apiKey }),
    defaultModel,
    requestTimeoutMs,
    steps: {
      // Entries (esp. merges) produce large JSON; the 4096 default truncates it
      // and breaks JSON extraction (same lesson as the memory consolidator).
      produce: { model: defaultModel, maxTokens: 16000 },
      contradict: { model: fastModel },
      classifyToSection: { model: fastModel },
      sectionSummary: { model: fastModel },
      labelSection: { model: fastModel },
    },
  });
}

/** Send a Telegram message as Dewey (best-effort; silent if unconfigured). */
async function tg(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat =
    process.env.TELEGRAM_CHAT_ID ?? process.env.WOLFPACK_OWNER_TELEGRAM_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: "Markdown" }),
    });
  } catch {
    /* never let a notification failure break a sweep */
  }
}

/** Count pending top-level contributions per wolf (excludes _processed/). */
function countPending(opsRoot: string): { total: number; wolves: string[] } {
  const inbox = join(opsRoot, "inbox");
  if (!existsSync(inbox)) return { total: 0, wolves: [] };
  let total = 0;
  const wolves: string[] = [];
  for (const wolf of readdirSync(inbox, { withFileTypes: true })) {
    if (!wolf.isDirectory()) continue;
    const n = readdirSync(join(inbox, wolf.name)).filter((f) =>
      f.endsWith(".md")
    ).length;
    if (n > 0) {
      total += n;
      wolves.push(`${wolf.name}(${n})`);
    }
  }
  return { total, wolves };
}

// ── Single-writer lock ──────────────────────────────────────────────────────
// The sweep writes entries, the ledger, the registry, and moves inbox files.
// Two concurrent sweeps race all of those (that is exactly what produced the
// overnight duplicate entries + ledger/registry drift). A den-local lock makes
// a second local sweep refuse rather than corrupt state. Stale locks (dead
// owner, or absurdly old) are reclaimed so a crash never wedges future runs.
const LOCK_STALE_MS = 30 * 60_000;
/** Path of a lock this process currently holds, so signal handlers can clean
 *  it up (SIGINT/SIGTERM skip the try/finally in cmdSweep). */
let heldLock: string | null = null;

function lockPath(roots: KbRoots): string {
  return join(roots.denLocal, "sweep.lock");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(roots: KbRoots): boolean {
  const p = lockPath(roots);
  mkdirSync(dirname(p), { recursive: true });
  if (existsSync(p)) {
    try {
      const info = JSON.parse(readFileSync(p, "utf-8")) as {
        pid: number;
        at: number;
      };
      const fresh = Date.now() - info.at < LOCK_STALE_MS;
      if (pidAlive(info.pid) && fresh) return false; // a live sweep holds it
      console.error(
        `reclaiming stale sweep lock (pid ${info.pid}, ${Math.round(
          (Date.now() - info.at) / 1000
        )}s old)`
      );
    } catch {
      /* unreadable lock → treat as stale and reclaim */
    }
  }
  writeFileSync(p, JSON.stringify({ pid: process.pid, at: Date.now() }));
  heldLock = p;
  return true;
}

function releaseLock(roots: KbRoots): void {
  try {
    unlinkSync(lockPath(roots));
  } catch {
    /* already gone */
  }
  heldLock = null;
}

async function cmdSweep(opts: { drain: boolean } = { drain: false }): Promise<void> {
  const roots = resolveRoots();
  if (!acquireLock(roots)) {
    console.error(
      "another sweep holds the lock — refusing to run concurrently. " +
        "Wait for it to finish (or remove a confirmed-stale lock)."
    );
    process.exit(1);
  }

  try {
    const engine = makeEngine();
    const embedder = createEmbedder(roots);

    const pending = countPending(roots.opsRoot);
    if (pending.total > 0) {
      await tg(
        `\u{1F9F9} *Dewey KB sweep* starting \u2014 ${pending.total} pending ` +
          `contribution(s) from ${pending.wolves.join(", ")}${
            opts.drain ? " (drain)" : ""
          }\u2026`
      );
    }

    // Aggregate across passes. In drain mode we loop until the inbox is truly
    // empty OR a pass makes no net progress (persistent failures must not spin
    // forever). We count the real inbox each pass — `remaining` only reflects
    // the per-tick batch cap, not items that failed and stayed behind.
    const tot = {
      processed: 0, created: 0, merged: 0, rejected: 0,
      unclassified: 0, crystallized: 0, errors: 0,
    };
    const suggested = new Set<string>();
    const failures: { from: string; denTopicId: string; reason: string }[] = [];
    let pass = 0;
    let stillPending = pending.total;

    while (true) {
      pass++;
      const before = countPending(roots.opsRoot).total;
      const r = await sweep({
        engine,
        roots,
        loadEntryVectors: () =>
          buildEntryVectors(roots, foldRegistry(readLedger(roots)), embedder),
        notify: (msg) => console.log(msg),
      });
      const after = countPending(roots.opsRoot).total;
      stillPending = after;

      tot.processed += r.processed; tot.created += r.created;
      tot.merged += r.merged; tot.rejected += r.rejected;
      tot.unclassified += r.unclassified; tot.crystallized += r.crystallized;
      tot.errors += r.errors;
      for (const d of r.suggestedDomains) suggested.add(d);
      for (const f of r.failures) failures.push(f);

      console.log(
        `pass ${pass}: ${r.processed} processed · ${r.created}c ${r.merged}m ` +
          `${r.rejected}r · ${r.unclassified} unclassified · ` +
          `${r.crystallized} crystallized · ${after} still pending`
      );

      if (!opts.drain) break;
      if (after === 0) break; // inbox fully drained
      if (after >= before) {
        console.log(
          `no net progress (${after} still pending — likely persistent errors); ` +
            `stopping drain. Re-run after addressing the failures.`
        );
        break;
      }
    }

    console.log(
      `done: ${tot.processed} processed · ${tot.created}c ${tot.merged}m ` +
        `${tot.rejected}r · ${tot.unclassified} unclassified · ` +
        `${tot.crystallized} crystallized` +
        (stillPending > 0 ? ` · ${stillPending} still pending` : " · inbox empty")
    );
    if (suggested.size) {
      console.log(
        `recommend new domain(s): ${[...suggested].join(", ")} ` +
          `(declare with: wolfpack domain add <name>)`
      );
    }

    // Surface failures grouped by reason — a stuck sweep should be legible at a
    // glance, not buried in per-contribution log lines.
    if (failures.length) {
      const byReason = new Map<string, string[]>();
      for (const f of failures) {
        const list = byReason.get(f.reason) ?? [];
        list.push(`${f.from}/${f.denTopicId}`);
        byReason.set(f.reason, list);
      }
      console.log(`\n⚠ ${failures.length} contribution(s) skipped (still in inbox):`);
      for (const [reason, items] of byReason) {
        console.log(`  • ${reason}`);
        for (const it of items) console.log(`      - ${it}`);
      }
    }

    console.log(engine.usage.summarize());

    if (tot.processed > 0) {
      const u = engine.usage.summarize();
      await tg(
        [
          `\u2705 *Dewey KB sweep* complete`,
          `\u2022 processed: ${tot.processed}`,
          `\u2022 created: ${tot.created}  merged: ${tot.merged}  rejected: ${tot.rejected}  errors: ${tot.errors}`,
          `\u2022 crystallized: ${tot.crystallized}`,
          stillPending > 0 ? `\u2022 still pending: ${stillPending}` : null,
          suggested.size > 0
            ? `\u2022 \u26a0 recommend domain(s): ${[...suggested].join(", ")}`
            : null,
          `\u2022 tokens: ${u.totalTokens}`,
        ]
          .filter(Boolean)
          .join("\n")
      );
    }
  } finally {
    releaseLock(roots);
  }
}

/** Count .md entry files on disk for a domain. */
function entryFilesOnDisk(roots: KbRoots, domain: string): string[] {
  const dir = entriesDir(roots, domain);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3));
}

/**
 * `status` — a read-only health + consistency dashboard. Surfaces, in one place,
 * the facts we previously had to reconstruct by hand: is a sweep running, what
 * is queued, and whether entries on disk, the ledger, and the registry agree.
 * Drift (orphans / missing files) is how a crashed or raced sweep silently
 * corrupts the KB, so it is flagged loudly here.
 */
async function cmdStatus(): Promise<void> {
  const roots = resolveRoots();

  const lp = lockPath(roots);
  let lockLine = "idle (no sweep running)";
  if (existsSync(lp)) {
    try {
      const info = JSON.parse(readFileSync(lp, "utf-8")) as { pid: number; at: number };
      const ageS = Math.round((Date.now() - info.at) / 1000);
      lockLine = pidAlive(info.pid)
        ? `RUNNING (pid ${info.pid}, started ${ageS}s ago)`
        : `STALE lock (pid ${info.pid} dead, ${ageS}s old) — next sweep reclaims`;
    } catch {
      lockLine = "lock present but unreadable — will be reclaimed";
    }
  }

  const events = readLedger(roots);
  const written = new Map<string, Set<string>>();
  let lastAt = "";
  for (const e of events as Array<Record<string, unknown>>) {
    if (typeof e.at === "string" && e.at > lastAt) lastAt = e.at;
    if (e.t === "entry_written" && typeof e.entryId === "string") {
      const m = /^kb-([a-z0-9-]+)-[^-]+$/.exec(e.entryId);
      const domain = m ? m[1] : "?";
      if (!written.has(domain)) written.set(domain, new Set());
      written.get(domain)!.add(e.entryId);
    }
  }

  const pending = countPending(roots.opsRoot);
  const uncDir = unclassifiedDir(roots);
  const unclassified = existsSync(uncDir)
    ? readdirSync(uncDir).filter((f) => f.endsWith(".md")).length
    : 0;

  const domainsRoot = join(roots.kbBase, "domains");
  const domains = existsSync(domainsRoot)
    ? readdirSync(domainsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    : [];

  // Topic registry is per-domain now (domains/<d>/_registry.md).
  let regTopics = 0;
  for (const d of domains) {
    const rf = domainRegistryFile(roots, d);
    if (existsSync(rf))
      regTopics += (readFileSync(rf, "utf-8").match(/^## /gm) ?? []).length;
  }

  console.log(`\u{1F9F9} Dewey KB status`);
  console.log(`  KB_BASE : ${roots.kbBase}`);
  console.log(`  KB_OPS  : ${roots.opsRoot}`);
  console.log(`  ledger  : ${events.length} events${lastAt ? `, last ${lastAt}` : ""}`);
  console.log(`  sweep   : ${lockLine}`);
  console.log(
    `  inbox   : ${pending.total} pending${
      pending.total ? ` — ${pending.wolves.join(", ")}` : ""
    }`
  );
  console.log(`  registry: ${regTopics} topic(s)`);
  if (unclassified > 0)
    console.log(`  ⚠ unclassified (undeclared domain, quarantined): ${unclassified}`);

  console.log(`\n  domain            files   ledger   drift`);
  let anyDrift = false;
  for (const domain of domains) {
    const files = new Set(entryFilesOnDisk(roots, domain));
    const led = written.get(domain) ?? new Set<string>();
    const orphans = [...files].filter((e) => !led.has(e));
    const missing = [...led].filter((e) => !files.has(e));
    if (orphans.length || missing.length) anyDrift = true;
    const drift =
      orphans.length || missing.length
        ? `⚠ ${orphans.length} orphan, ${missing.length} missing`
        : "ok";
    console.log(
      `  ${domain.padEnd(16)} ${String(files.size).padStart(5)}   ${String(
        led.size
      ).padStart(6)}   ${drift}`
    );
  }
  if (anyDrift)
    console.log(
      `\n  ⚠ drift — orphan = entry file with no ledger record (crashed/raced ` +
        `sweep debris); missing = ledgered entry whose file is gone. Reconcile ` +
        `before trusting those domains.`
    );
  else if (domains.length)
    console.log(`\n  ✓ files and ledger agree across all domains.`);
}

/**
 * `reindex` — re-render the read-only projections (per-domain `_registry.md` and
 * `INDEX.md`) from the current ledger, without running a sweep or any LLM. Pure
 * and deterministic. Use after a code change to the projection format, or to
 * regenerate the registry when the inbox is empty (a no-op sweep won't).
 */
async function cmdReindex(): Promise<void> {
  const roots = resolveRoots();
  const reg = foldRegistry(readLedger(roots));
  const regDomains = renderRegistry(roots, reg);
  const domainsRoot = join(roots.kbBase, "domains");
  const domains = existsSync(domainsRoot)
    ? readdirSync(domainsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    : [];
  for (const d of domains) renderDomainIndex(roots, d);
  console.log(
    `reindex: per-domain registry for ${regDomains.length} domain(s)` +
      `${regDomains.length ? ` [${regDomains.join(", ")}]` : ""}, ` +
      `INDEX for ${domains.length} domain(s)`
  );
}

async function cmdRebuildVectors(): Promise<void> {
  const roots = resolveRoots();
  const dir = vectorsDir(roots);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    console.log(`cleared vector cache: ${dir}`);
  }
  const embedder = createEmbedder(roots);
  const vectors = await buildEntryVectors(
    roots,
    foldRegistry(readLedger(roots)),
    embedder
  );
  console.log(`re-embedded ${vectors.length} entries`);
}

// ════════════════════════════════════════════════════════════════════════════
// reorg — the missing maintenance pass (split / merge / crystallize / re-label)
// ════════════════════════════════════════════════════════════════════════════

async function cmdReorg(): Promise<void> {
  const roots = resolveRoots();
  const argv = process.argv.slice(2);
  const domainFilter = argv.find((a) => !a.startsWith("--") && a !== "reorg") ?? null;
  const dryRun = argv.includes("--dry-run");
  // Re-summarize + re-label every section, not just dirty ones (e.g. after a
  // SECTION_SUMMARY_SYSTEM / LABEL_SECTION_SYSTEM change).
  const resummarizeAll = argv.includes("--resummarize-all");

  const domainsRoot = join(roots.kbBase, "domains");
  if (!existsSync(domainsRoot)) {
    console.error("no domains/ found under KB_BASE");
    process.exit(1);
  }
  const allDomains = readdirSync(domainsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const domains = domainFilter ? allDomains.filter((d) => d === domainFilter) : allDomains;
  if (domains.length === 0) {
    console.error(domainFilter ? `domain "${domainFilter}" not found` : "no domains");
    process.exit(1);
  }

  // Build entry vectors and read sections
  const reg = foldRegistry(readLedger(roots));
  const embedder = createEmbedder(roots);
  const allVectors = await buildEntryVectors(roots, reg, embedder);
  let sections = readSections(roots);
  const engine = makeEngine();
  const events: KbEvent[] = [];

  for (const domain of domains) {
    console.log(`\n─── reorg: ${domain} ───`);
    const domainVectors = allVectors.filter((v) => v.domain === domain);
    const eDir = join(domainsRoot, domain, "entries");

    // Build entry→section map from frontmatter
    const entrySectionMap = new Map<string, string>();
    if (existsSync(eDir)) {
      for (const f of readdirSync(eDir).filter((x) => x.endsWith(".md"))) {
        const { fields } = parseFrontmatter(readFileSync(join(eDir, f), "utf-8"));
        const eid = String(fields.id ?? f.replace(/\.md$/, ""));
        const sec = String(fields.section ?? "");
        if (sec) entrySectionMap.set(eid, sec);
      }
    }

    // ── 1. Reconcile memberCount ─────────────────────────────────────────
    const sectionMembers = new Map<string, EntryWithVector[]>();
    const unplaced: EntryWithVector[] = [];
    for (const v of domainVectors) {
      const sec = entrySectionMap.get(v.entryId);
      if (sec) {
        if (!sectionMembers.has(sec)) sectionMembers.set(sec, []);
        sectionMembers.get(sec)!.push({
          entryId: v.entryId,
          sectionId: sec as SectionId,
          vector: v.vector,
        });
      } else {
        unplaced.push({
          entryId: v.entryId,
          sectionId: "_unplaced" as SectionId,
          vector: v.vector,
        });
      }
    }

    let memberCountFixes = 0;
    for (const s of sections.filter((s) => s.domain === domain)) {
      const actual = sectionMembers.get(s.id)?.length ?? 0;
      if (s.memberCount !== actual) {
        console.log(`  memberCount fix: ${s.id} ${s.memberCount} → ${actual}`);
        s.memberCount = actual;
        s.dirty = true;
        memberCountFixes++;
      }
    }
    if (memberCountFixes) console.log(`  fixed ${memberCountFixes} stale memberCount(s)`);

    // ── 2. Split overflow sections ───────────────────────────────────────
    const domainSections = sections.filter((s) => s.domain === domain);
    const toSplit = domainSections.filter(
      (s) => (sectionMembers.get(s.id)?.length ?? 0) > 8
    );
    for (const sec of toSplit) {
      const members = sectionMembers.get(sec.id) ?? [];
      const result = maybeSplit(sec, members);
      if (!result) {
        console.log(`  skip split: ${sec.id} (k-means didn't find a clean cut)`);
        continue;
      }
      console.log(
        `  split: ${sec.id} (${members.length} entries) → ` +
          result.children.map((c) => `${c.id}(${result.reassignment.size > 0 ? [...result.reassignment.values()].filter((v) => v === c.id).length : "?"})`).join(" + ")
      );
      if (!dryRun) {
        // Add children to section tree
        sec.childIds.push(...result.children.map((c) => c.id));
        sec.dirty = true;
        sections = [...sections, ...result.children];

        events.push(
          ev.sectionSplit(sec.id, sec.parent ?? "", result.children.map((c) => c.id))
        );
        for (const child of result.children) {
          events.push(
            ev.sectionCreated({
              sectionId: child.id,
              domain,
              parent: sec.id,
              label: String(child.label),
            })
          );
        }

        // Update entry section in frontmatter
        for (const [entryId, newSecId] of result.reassignment) {
          const file = join(eDir, `${entryId}.md`);
          if (existsSync(file)) {
            let content = readFileSync(file, "utf-8");
            content = content.replace(
              /^section: .+$/m,
              `section: ${newSecId}`
            );
            content = content.replace(
              /^(placement:)\n(  basis: ).+$/m,
              `$1\n$2routed`
            );
            writeFileSync(file, content);
          }
          events.push(
            ev.entryPlaced({
              entryId,
              sectionId: newSecId,
              basis: "routed",
              fit: 1,
            })
          );
        }

        // Update sectionMembers map for merge check
        sectionMembers.delete(sec.id);
        for (const child of result.children) {
          const childMembers = members.filter(
            (m) => result.reassignment.get(m.entryId) === child.id
          );
          sectionMembers.set(child.id, childMembers.map((m) => ({
            ...m,
            sectionId: child.id,
          })));
        }
      }
    }

    // ── 3. Merge underfull sections ──────────────────────────────────────
    let merged = 0;
    for (const sec of [...sections].filter((s) => s.domain === domain)) {
      const parentId = shouldMerge(sec);
      if (!parentId) continue;
      const parent = sections.find((s) => s.id === parentId);
      if (!parent) continue;
      const members = sectionMembers.get(sec.id) ?? [];
      console.log(
        `  merge: ${sec.id} (${members.length} entries) → parent ${parentId}`
      );
      if (!dryRun) {
        // Move entries to parent
        for (const m of members) {
          const file = join(eDir, `${m.entryId}.md`);
          if (existsSync(file)) {
            let content = readFileSync(file, "utf-8");
            content = content.replace(/^section: .+$/m, `section: ${parentId}`);
            writeFileSync(file, content);
          }
          events.push(
            ev.entryPlaced({ entryId: m.entryId, sectionId: parentId, basis: "routed", fit: 1 })
          );
        }
        // Transfer member list
        const parentMembers = sectionMembers.get(parentId) ?? [];
        sectionMembers.set(parentId, [
          ...parentMembers,
          ...members.map((m) => ({ ...m, sectionId: parentId as SectionId })),
        ]);
        sectionMembers.delete(sec.id);
        parent.memberCount += members.length;
        parent.childIds = parent.childIds.filter((c) => c !== sec.id);
        parent.dirty = true;
        sections = sections.filter((s) => s.id !== sec.id);
        merged++;
      }
    }
    if (merged) console.log(`  merged ${merged} underfull section(s)`);

    // ── 4. Crystallize unplaced entries ──────────────────────────────────
    if (unplaced.length > 0) {
      const domSections = sections.filter((s) => s.domain === domain);
      const candidates = crystallizeUnplaced(unplaced, domSections, domain as DomainId);
      for (const c of candidates) {
        console.log(
          `  crystallize: ${c.section.id} (${c.entryIds.length} entries, cohesion=${c.cohesion.toFixed(3)})`
        );
        if (!dryRun) {
          sections = [...sections, c.section];
          events.push(
            ev.sectionCreated({
              sectionId: c.section.id,
              domain,
              parent: c.section.parent,
              label: String(c.section.label),
            })
          );
          events.push(
            ev.sectionCrystallized({
              sectionId: c.section.id,
              parentId: c.section.parent ?? "",
              entryIds: c.entryIds,
              cohesion: c.cohesion,
            })
          );
          for (const eid of c.entryIds) {
            const file = join(eDir, `${eid}.md`);
            if (existsSync(file)) {
              let content = readFileSync(file, "utf-8");
              content = content.replace(
                /^section: .+$/m,
                `section: ${c.section.id}`
              );
              writeFileSync(file, content);
            }
            events.push(
              ev.entryPlaced({ entryId: eid, sectionId: c.section.id, basis: "crystallized", fit: 1 })
            );
          }
        }
      }
      if (candidates.length === 0) {
        console.log(`  ${unplaced.length} unplaced entry(s) — not cohesive enough to crystallize`);
      }
    }

    // ── 5. Refresh dirty section summaries + titles ──────────────────────
    const dirty = sections.filter((s) => s.domain === domain && (s.dirty || resummarizeAll));
    if (dirty.length > 0) {
      console.log(`  labeling ${dirty.length} ${resummarizeAll ? "" : "dirty "}section(s)…`);
      for (const sec of dirty) {
        const members = sectionMembers.get(sec.id) ?? [];
        const memberInfo: SectionMember[] = [];
        for (const m of members) {
          const file = join(eDir, `${m.entryId}.md`);
          if (existsSync(file)) {
            const { fields } = parseFrontmatter(readFileSync(file, "utf-8"));
            memberInfo.push({
              title: String(fields.title ?? m.entryId),
              summary: fields.summary ? String(fields.summary) : undefined,
            });
          }
        }
        const entryTitles = memberInfo.map((m) => m.title);
        // Compute summary from member titles + summaries
        if (memberInfo.length > 0 && !dryRun) {
          try {
            sec.summary = await sectionSummary(engine, memberInfo);
            const parent = sec.parent ? sections.find((s) => s.id === sec.parent) : null;
            const siblings = sections
              .filter((s) => s.parent === sec.parent && s.id !== sec.id && s.domain === domain)
              .map((s) => s.summary);
            const oldTitle = sec.title;
            sec.title = await labelSection(engine, sec.summary, {
              sampleTitles: entryTitles,
              parentTitle: parent?.title,
              siblingSummaries: siblings,
            });
            sec.dirty = false;
            sec.updated = new Date().toISOString().split("T")[0] as any;
            console.log(`    ${sec.id}: "${oldTitle}" → "${sec.title}"`);
          } catch (e) {
            console.error(`    ${sec.id}: label failed: ${e}`);
          }
        } else if (dryRun) {
          console.log(`    ${sec.id}: would re-label (${memberInfo.length} member(s)) "${sec.title}"`);
        }
      }
    }
  }

  // ── Persist ──────────────────────────────────────────────────────────────
  if (dryRun) {
    console.log(`\n[dry-run] ${events.length} event(s) would be emitted. No writes.`);
    return;
  }

  if (events.length > 0) {
    appendLedger(roots, events);
    console.log(`\nappended ${events.length} event(s) to ledger`);
  }
  writeSections(roots, sections);

  // Re-render digest + index for each touched domain
  for (const domain of domains) {
    renderDomainDigest(roots, domain);
    renderDomainIndex(roots, domain);
  }
  console.log(`re-rendered digest + index for ${domains.length} domain(s)`);

  // Notify
  const splitCount = events.filter((e) => e.t === "section_split").length;
  const crystalCount = events.filter((e) => e.t === "section_crystallized").length;
  const placeCount = events.filter((e) => e.t === "entry_placed").length;
  await tg(
    `\u{1f4d0} reorg complete: ${splitCount} split(s), ${crystalCount} crystallized, ` +
      `${placeCount} entry placement(s) across ${domains.length} domain(s)`
  );
}

// ════════════════════════════════════════════════════════════════════════════
// retire — remove entries on the librarian (wolf mirrors are receive-only)
// ════════════════════════════════════════════════════════════════════════════

async function cmdRetire(): Promise<void> {
  const roots = resolveRoots();
  const argv = process.argv.slice(3);
  const ids = argv.filter((a) => !a.startsWith("--"));
  const dryRun = argv.includes("--dry-run");
  const reason = argv.find((a) => a.startsWith("--reason="))?.slice("--reason=".length) || undefined;
  if (ids.length === 0) {
    console.error("usage: retire <entryId...> [--reason=<text>] [--dry-run]");
    process.exit(1);
  }
  if (!dryRun && !acquireLock(roots)) {
    console.error("a sweep is running (sweep.lock held); retry when it finishes");
    process.exit(1);
  }
  try {
    const r = retireEntries(roots, ids, { reason, dryRun });
    for (const e of r.retired) {
      console.log(`${dryRun ? "would retire" : "retired"} ${e.entryId}${e.hadFile ? "" : " (file already gone; registry only)"}`);
    }
    for (const id of r.notFound) console.log(`not found: ${id} (no file, not in registry)`);
    if (dryRun) {
      console.log(`[dry-run] no writes.`);
    } else if (r.retired.length) {
      console.log(`re-rendered registry, INDEX, and digest for: ${r.domains.join(", ")}`);
      console.log(`section member counts refresh on the next \`reorg\`.`);
    }
  } finally {
    if (!dryRun) releaseLock(roots);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "sweep";
  const drain = argv.includes("--drain") || argv.includes("--all");
  switch (cmd) {
    case "sweep":
      await cmdSweep({ drain });
      break;
    case "rebuild-vectors":
      await cmdRebuildVectors();
      break;
    case "status":
    case "doctor":
      await cmdStatus();
      break;
    case "reindex":
      await cmdReindex();
      break;
    case "reorg":
      await cmdReorg();
      break;
    case "retire":
      await cmdRetire();
      break;
    default:
      console.error(
        `Unknown command: ${cmd}. Use: status | sweep [--drain] | reindex | rebuild-vectors | reorg [domain] [--dry-run] [--resummarize-all] | retire <entryId...> [--reason=…] [--dry-run]`
      );
      process.exit(1);
  }
}

// Drop a held lock on interruption so a Ctrl-C never wedges future sweeps.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (heldLock) {
      try {
        unlinkSync(heldLock);
      } catch {
        /* best effort */
      }
    }
    process.exit(130);
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
