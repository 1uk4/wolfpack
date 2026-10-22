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
 *   ANTHROPIC_API_KEY     — required only when the wolf's transport is api
 *   (models come from the resolved model table — see loadModelTable)
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
import { createEngine, engineSteps, loadModelTable, type ModelTable } from "@wolfpack/engine";
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
  foldRegistry,
  renderRegistry,
  renderDomainIndex,
  createEmbedder,
  buildEntryVectors,
} from "./librarian/index.js";
import { retireEntries } from "./librarian/retire.js";
import { reorg as reorgFn } from "./librarian/reorg.js";
import { unpark, listParked } from "./librarian/park.js";
import { readCurrent, oldestInbox, formatAge } from "./librarian/progress.js";

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
  // Models and transport come from the resolved table: the shipped models.json
  // beside wolf.yaml on a VPS wolf, else the pack config + wolf.yaml.
  let table: ModelTable;
  try {
    ({ table } = loadModelTable());
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const provider = table.tiers.smart.provider;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (provider === "anthropic" && !apiKey) {
    console.error("ANTHROPIC_API_KEY is required (this wolf's transport is api)");
    process.exit(1);
  }
  const steps = engineSteps(table);
  // Bound a single hanging call (anthropic path only; the bridge has no API
  // timeout and ignores this). Default 10m is generous enough for a large
  // 16k-token produce but still caps a wedged request. Tunable per run.
  const requestTimeoutMs =
    Number(process.env.WOLFPACK_REQUEST_TIMEOUT_MS) || 600_000;
  return createEngine({
    provider,
    ...(provider === "anthropic" ? { apiKey } : {}),
    defaultModel: table.tiers.smart.model,
    requestTimeoutMs,
    steps: {
      ...steps,
      // Entries (esp. merges) produce large JSON; the 4096 default truncates it
      // and breaks JSON extraction (same lesson as the memory consolidator).
      produce: { ...steps.produce, maxTokens: 16000 },
    },
  });
}

/** Send a Telegram message as Dewey (best-effort; silent if unconfigured). */
async function tg(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  // The systemd unit sets WOLFPACK_OWNER_TELEGRAM_ID; a wolf's .env uses TELEGRAM_OWNER_ID.
  const chat =
    process.env.TELEGRAM_CHAT_ID ??
    process.env.WOLFPACK_OWNER_TELEGRAM_ID ??
    process.env.TELEGRAM_OWNER_ID;
  if (!token || !chat) {
    console.error("telegram: not configured (TELEGRAM_BOT_TOKEN + owner/chat id), alert not sent");
    return;
  }
  // Never let a notification failure break a sweep — but say so in the log.
  try {
    const send = (parse_mode?: string) =>
      fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text, ...(parse_mode ? { parse_mode } : {}) }),
      });
    let res = await send("Markdown");
    // A Markdown parse error (stray _ or * in an id) is a 400: resend as plain text.
    if (res.status === 400) res = await send();
    if (!res.ok) console.error(`telegram: send failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  } catch (e) {
    console.error(`telegram: send failed: ${e instanceof Error ? e.message : e}`);
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
  } catch (err) {
    // EPERM: the process exists but belongs to another user (e.g. a root CLI
    // run seen from the wolf's sweep). Only ESRCH means it is gone.
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
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
    // the one-per-run cap, not items that failed and stayed behind.
    const tot = {
      processed: 0, created: 0, merged: 0, rejected: 0,
      unclassified: 0, crystallized: 0, errors: 0,
    };
    const suggested = new Set<string>();
    const failures: { from: string; denTopicId: string; reason: string }[] = [];
    const parked: { from: string; denTopicId: string; reason: string }[] = [];
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
      for (const p of r.parked) parked.push(p);

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
      console.log(`\n⚠ ${failures.length} contribution(s) skipped (still in inbox, will retry):`);
      for (const [reason, items] of byReason) {
        console.log(`  • ${reason}`);
        for (const it of items) console.log(`      - ${it}`);
      }
    }

    if (parked.length) {
      console.log(`\n⛔ ${parked.length} contribution(s) parked (run \`wolfpack-kb unpark\` to retry):`);
      for (const p of parked) console.log(`  • ${p.from}/${p.denTopicId} — ${p.reason}`);
      await tg(
        [
          `\u26d4 *Dewey KB sweep* parked ${parked.length} contribution(s)`,
          ...parked.map((p) => `\u2022 ${p.from}/${p.denTopicId}: ${p.reason}`),
          `Retry with \`wolfpack-kb unpark\` once fixed.`,
        ].join("\n")
      );
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
  const current = readCurrent(roots);
  if (current && existsSync(lp)) {
    console.log(
      `  working : ${current.from}/${current.denTopicId} for ${formatAge(Date.now() - current.startedAt)}` +
        (current.route ? ` — ${current.route}` : "")
    );
  }
  const oldest = oldestInbox(roots);
  console.log(
    `  inbox   : ${pending.total} pending${
      pending.total ? ` — ${pending.wolves.join(", ")}` : ""
    }${oldest ? `; oldest ${oldest.wolf}/${oldest.file} waiting ${formatAge(oldest.ageMs)}` : ""}`
  );
  const parkedItems = listParked(roots);
  if (parkedItems.length) {
    console.log(`  ⛔ parked: ${parkedItems.length} — ${parkedItems.map((p) => `${p.wolf}/${p.file}`).join(", ")} (wolfpack-kb unpark)`);
  }
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
  const resummarizeAll = argv.includes("--resummarize-all");

  // A real reorg rewrites sections and the ledger: it must not overlap a sweep.
  if (!dryRun && !acquireLock(roots)) {
    console.error("a sweep is running (sweep.lock held); retry when it finishes");
    process.exit(1);
  }
  try {
    const engine = makeEngine();
    const result = await reorgFn({
      engine,
      roots,
      domains: domainFilter ? [domainFilter] : undefined,
      dryRun,
      resummarizeAll,
      notify: (msg) => console.log(`  ${msg}`),
    });
    const mode = dryRun ? " (dry-run)" : "";
    console.log(
      `\nreorg done${mode}: ${result.splits} split(s), ${result.merges} merge(s), ` +
      `${result.placements} placement(s), ${result.labelsUpdated} labeled across ` +
      `${result.domains.length} domain(s)`
    );
    if (!dryRun) {
      await tg(
        `\u{1f4d0} reorg complete: ${result.splits} split(s), ${result.merges} merge(s), ` +
          `${result.placements} entry placement(s) across ${result.domains.length} domain(s)`
      );
    }
  } finally {
    if (!dryRun) releaseLock(roots);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// retire — remove entries on the librarian (wolf mirrors are receive-only)
// ════════════════════════════════════════════════════════════════════════════

async function cmdRebuild(): Promise<void> {
  const roots = resolveRoots();
  const argv = process.argv.slice(2);
  const domain = argv.find((a) => !a.startsWith("--") && a !== "rebuild") ?? null;

  if (!domain) {
    console.error("Usage: wolfpack-kb rebuild <domain>");
    process.exit(1);
  }

  console.log(`\n── rebuild: ${domain} (full section tree reconstruction) ──`);

  const engine = makeEngine();
  const result = await reorgFn({
    engine,
    roots,
    domains: [domain],
    rebuild: true,
    notify: (msg) => console.log(`  ${msg}`),
  });

  console.log(
    `\nrebuild done: ${result.placements} entries placed, ` +
    `${result.labelsUpdated} sections labeled, ` +
    `${result.splits} splits, ${result.merges} merges` +
    (result.rebuilt ? " (full rebuild)" : "")
  );
}

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

// ════════════════════════════════════════════════════════════════════════════
// unpark — send parked contributions back to the inbox for the next sweep
// ════════════════════════════════════════════════════════════════════════════

async function cmdUnpark(): Promise<void> {
  const roots = resolveRoots();
  const arg = process.argv.slice(3).find((a) => !a.startsWith("--"));
  if (process.argv.includes("--list") || (!arg && !process.argv.includes("--all"))) {
    const items = listParked(roots);
    if (!items.length) console.log("nothing parked");
    for (const p of items) console.log(`${p.wolf}/${p.file}`);
    if (items.length) console.log(`\nunpark one with: unpark <wolf>/<file>  ·  all with: unpark --all`);
    return;
  }
  const moved = unpark(roots, arg);
  for (const p of moved) console.log(`unparked ${p.wolf}/${p.file}`);
  console.log(moved.length ? `${moved.length} back in the inbox; the next sweep retries them` : `no parked item matches ${arg}`);
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
    case "rebuild":
      await cmdRebuild();
      break;
    case "retire":
      await cmdRetire();
      break;
    case "unpark":
      await cmdUnpark();
      break;
    default:
      console.error(
        `Unknown command: ${cmd}. Use: status | sweep [--drain] | reindex | rebuild-vectors | reorg [domain] [--dry-run] [--resummarize-all] | retire <entryId...> [--reason=…] [--dry-run] | unpark [<wolf>/<file> | <wolf> | --all | --list]`
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
