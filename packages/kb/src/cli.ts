#!/usr/bin/env node
/**
 * wolfpack-kb — the librarian's KB engine CLI. `sweep` is the same tick the
 * harness timer runs on VPS librarians (runSweepTick); on a local Mac a launchd
 * job runs it every minute (see packages/cli/src/local-librarian.ts).
 *
 * Commands:
 *   status            read-only health + consistency dashboard (no writes):
 *                     sweep lock, inbox backlog, and file↔ledger drift per
 *                     domain. Start here when something looks off.
 *   sweep [--drain]   one tick: route → produce → commit one contribution (places
 *                     it top-down; no reorg unless WOLFPACK_KB_POST_SWEEP_REORG=1). Add --drain to loop ticks
 *                     until the inbox is empty, the sweep is paused by an
 *                     outage, or a tick makes no progress (manual/dev use).
 *   history <id>      list an entry's kept versions (`--show <timestamp>` prints one)
 *   rebuild <domain> (--dry-run | --yes) [--from-current | --from-scratch] [--allow-collapse]
 *                     development baseline: rebuild one domain's section tree in memory. --dry-run
 *                     writes only kb-rebuild-proposal.md in the cwd. --from-current (default) keeps the
 *                     existing sections and judges only oversized ones; --from-scratch starts at one root.
 *                     Refinement moves apply only inside one top-level section; moves into another are
 *                     listed in the proposal and applied only with --apply-cross-moves.
 *                     --yes commits after saving timestamped backups in the den-local dir:
 *                     sections.json.pre-rebuild-<ts> and .rebuild-old-sections-<ts>.json.
 *                     RESTORE: `rebuild --restore <ts> --yes` puts the snapshot and every entry's old
 *                     section: line back. An interrupted commit is finished by the next sweep/tick.
 *   rebuild-vectors   wipe + re-embed the entry-vector cache (model change etc.)
 *
 * A den-local lock (sweep.lock) guarantees a single writer — a second sweep
 * skips its tick rather than racing (stale locks are auto-reclaimed).
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
import { rmSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { loadModelTable, type Engine } from "@wolfpack/engine";
import type { KbRoots } from "./shared/index.js";
import {
  vectorsDir,
  entriesDir,
  domainRegistryFile,
  unclassifiedDir,
  ledgerFile,
} from "./shared/index.js";
import {
  runSweepTick,
  createLibrarianEngine,
  readLedger,
  foldRegistry,
  renderRegistry,
  renderDomainIndex,
  createEmbedder,
  buildEntryVectors,
} from "./librarian/index.js";
import { retireEntries } from "./librarian/retire.js";
import { listVersions, readVersion } from "./librarian/versions.js";
import { EntryId } from "./schema/knowledge.js";
import { ledgeredByDomain, driftOf } from "./librarian/drift.js";
import { reorg as reorgFn } from "./librarian/reorg.js";
import { listRebuildBackups, restoreRebuild } from "./librarian/rebuild-commit.js";
import { unpark, listParked } from "./librarian/park.js";
import { acquireKbLock, kbLockFile, pidAlive, releaseOwnedLock } from "./librarian/lock.js";
import { countPending } from "./librarian/intake.js";
import { readCurrent, oldestInbox, formatAge } from "./librarian/progress.js";

/** Roots of this run, so the signal handler can drop the lock it holds. */
let activeRoots: KbRoots | null = null;

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
  activeRoots = {
    kbBase: resolve(kbBase),
    opsRoot: resolve(opsRoot),
    // den-local KB state (ledger/vectors). Overridable so it can live outside
    // the (user-owned, synced) den when the sweep runs as root.
    denLocal: resolve(process.env.KB_DEN_LOCAL ?? join(denRoot, "kb")),
  };
  return activeRoots;
}

/** The librarian engine, built from the resolved model table: the shipped
 *  models.json beside wolf.yaml on a VPS wolf, else the pack config + wolf.yaml. */
function makeEngine(): Engine {
  return createLibrarianEngine(loadModelTable().table);
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

async function cmdSweep(opts: { drain: boolean } = { drain: false }): Promise<void> {
  const roots = resolveRoots();
  // One engine for every tick of this run, so usage adds up.
  let engine: Engine | undefined;
  const createEngine = () => (engine ??= makeEngine());

  // Aggregate across ticks. In drain mode we loop until the inbox is empty, the
  // sweep is paused by an outage, OR a tick makes no net progress (persistent
  // failures must not spin forever). We count the real inbox each tick —
  // `remaining` only reflects the one-per-tick cap, not items that failed and
  // stayed behind.
  const tot = { processed: 0, created: 0, merged: 0, rejected: 0, unclassified: 0, errors: 0 };
  const failures: { from: string; denTopicId: string; reason: string }[] = [];
  const parked: { from: string; denTopicId: string; reason: string }[] = [];
  let pass = 0;
  let stillPending = 0;

  while (true) {
    pass++;
    const before = countPending(roots.opsRoot).total;
    const t = await runSweepTick({ roots, createEngine, notify: (msg) => console.log(msg), alert: tg });
    if (t.outcome === "idle") {
      // The launchd job runs every minute: stay silent unless a person is watching.
      if (pass === 1 && process.stdout.isTTY) console.log("inbox empty");
      stillPending = 0;
      break;
    }
    if (t.outcome === "backoff") {
      console.log(`sweep paused: ${t.sweep.paused}`);
      stillPending = countPending(roots.opsRoot).total;
      break;
    }
    const r = t.sweep;
    stillPending = countPending(roots.opsRoot).total;

    tot.processed += r.processed; tot.created += r.created;
    tot.merged += r.merged; tot.rejected += r.rejected;
    tot.unclassified += r.unclassified; tot.errors += r.errors;
    for (const f of r.failures) failures.push(f);
    for (const p of r.parked) parked.push(p);

    console.log(
      `pass ${pass}: ${r.processed} processed · ${r.created}c ${r.merged}m ` +
        `${r.rejected}r · ${r.unclassified} unclassified · ${stillPending} still pending`
    );

    if (!opts.drain || r.paused) break;
    if (stillPending === 0) break; // inbox fully drained
    if (stillPending >= before) {
      console.log(
        `no net progress (${stillPending} still pending — likely persistent errors); ` +
          `stopping drain. Re-run after addressing the failures.`
      );
      break;
    }
  }

  if (!engine) return; // idle or paused before any work

  console.log(
    `done: ${tot.processed} processed · ${tot.created}c ${tot.merged}m ` +
      `${tot.rejected}r · ${tot.unclassified} unclassified` +
      (stillPending > 0 ? ` · ${stillPending} still pending` : " · inbox empty")
  );

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
  }

  if (engine) console.log(engine.usage.summarize());
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

  const lp = kbLockFile(roots);
  let lockLine = "idle (no sweep running)";
  if (existsSync(lp)) {
    try {
      const info = JSON.parse(readFileSync(lp, "utf-8")) as { pid: number; at: number };
      const ageS = Math.round((Date.now() - info.at) / 1000);
      const beatS = Math.round((Date.now() - statSync(lp).mtimeMs) / 1000);
      lockLine = pidAlive(info.pid)
        ? `RUNNING (pid ${info.pid}, started ${ageS}s ago, heartbeat ${beatS}s ago)`
        : `STALE lock (pid ${info.pid} dead, ${ageS}s old) — next sweep reclaims`;
    } catch {
      lockLine = "lock present but unreadable — will be reclaimed";
    }
  }

  const events = readLedger(roots);
  let lastAt = "";
  for (const e of events as Array<Record<string, unknown>>) {
    if (typeof e.at === "string" && e.at > lastAt) lastAt = e.at;
  }
  const written = ledgeredByDomain(events as Array<Record<string, unknown>>);

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
    const { orphans, missing } = driftOf(files, led);
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
      `\n  ⚠ drift — orphan = entry file with no live ledger record (written ` +
        `outside the ledger, or retired but still on disk); missing = entry ` +
        `written to the ledger, never retired, whose file is gone. Retired ` +
        `entries are not counted. Investigate before trusting those domains.`
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
  const release = dryRun ? () => {} : acquireKbLock(roots);
  if (!release) {
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
    release();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// retire — remove entries on the librarian (wolf mirrors are receive-only)
// ════════════════════════════════════════════════════════════════════════════

async function cmdRebuild(): Promise<void> {
  const roots = resolveRoots();
  const argv = process.argv.slice(2);
  const restoreAt = argv.includes("--restore") ? argv[argv.indexOf("--restore") + 1] : null;
  const domain = argv.find((a, i) => !a.startsWith("--") && a !== "rebuild" && argv[i - 1] !== "--restore") ?? null;

  if (restoreAt) {
    if (!argv.includes("--yes")) {
      console.error(`restore puts back the section: lines and the sections snapshot saved before the rebuild stamped ${restoreAt}.\nKnown backups: ${listRebuildBackups(roots).join(", ") || "none"}\nRe-run with --yes.`);
      process.exit(2);
    }
    const release = acquireKbLock(roots);
    if (!release) { console.error("a sweep is running (sweep.lock held); retry when it finishes"); process.exit(1); }
    try {
      const r = restoreRebuild(roots, restoreAt);
      console.log(`restored ${r.entriesRestored} entry file(s) and the sections snapshot from ${restoreAt}`);
    } finally { release(); }
    return;
  }

  if (!domain) {
    console.error("Usage: wolfpack-kb rebuild <domain> (--dry-run | --yes) [--from-current | --from-scratch] [--allow-collapse] [--apply-cross-moves]\n       wolfpack-kb rebuild --restore <timestamp> --yes");
    process.exit(1);
  }

  const dryRun = argv.includes("--dry-run");
  if (!dryRun && !argv.includes("--yes")) {
    console.error(
      `rebuild rewrites the section: line of every entry in "${domain}" and replaces its whole section tree.\n` +
      `Preview it with:  wolfpack-kb rebuild ${domain} --dry-run\n` +
      `Then run it with: wolfpack-kb rebuild ${domain} --yes   (backs up sections.json and the old section values first)`
    );
    process.exit(2);
  }
  if (argv.includes("--from-current") && argv.includes("--from-scratch")) {
    console.error("--from-current and --from-scratch are exclusive");
    process.exit(1);
  }
  const rebuildFrom = argv.includes("--from-scratch") ? "scratch" : "current";
  console.log(`\n── rebuild${dryRun ? " (dry-run: no KB file is written; LLM label calls are made and the vector cache may be warmed)" : ""}: ${domain} (from ${rebuildFrom === "current" ? "the current tree: only oversized sections are judged" : "scratch: one root, every section judged"}) ──`);

  const engine = makeEngine();
  const result = await reorgFn({
    engine,
    roots,
    domains: [domain],
    rebuild: true,
    rebuildFrom,
    allowCollapse: argv.includes("--allow-collapse"),
    applyCrossMoves: argv.includes("--apply-cross-moves"),
    dryRun,
    proposalPath: dryRun ? join(process.cwd(), "kb-rebuild-proposal.md") : undefined,
    notify: (msg) => console.log(`  ${msg}`),
  });
  if (dryRun && result.proposal) {
    console.log(`\n${result.proposal}`);
    console.log(`proposal written to ${join(process.cwd(), "kb-rebuild-proposal.md")}`);
  }

  console.log(
    `\nrebuild done: ${result.placements} entries placed, ` +
    `${result.labelsUpdated} sections labeled, ` +
    `${result.splits} splits` +
    (result.rebuilt ? " (rebuild)" : "")
  );
}

async function cmdRetire(): Promise<void> {
  const roots = resolveRoots();
  const argv = process.argv.slice(3);
  const ids = argv.filter((a) => !a.startsWith("--"));
  const dryRun = argv.includes("--dry-run");
  const force = argv.includes("--force");
  const reason = argv.find((a) => a.startsWith("--reason="))?.slice("--reason=".length) || undefined;
  if (ids.length === 0) {
    console.error("usage: retire <entryId...> [--reason=<text>] [--dry-run] [--force]");
    process.exit(1);
  }
  const release = dryRun ? () => {} : acquireKbLock(roots);
  if (!release) {
    console.error("a sweep is running (sweep.lock held); retry when it finishes");
    process.exit(1);
  }
  try {
    const r = retireEntries(roots, ids, { reason, dryRun, force });
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
    release();
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

async function cmdHistory(): Promise<void> {
  const roots = resolveRoots();
  const argv = process.argv.slice(3);
  const showAt = argv.findIndex((a) => a === "--show" || a.startsWith("--show="));
  const show = showAt < 0 ? undefined : argv[showAt].includes("=") ? argv[showAt].split("=")[1] : argv[showAt + 1];
  const id = argv.find((a, i) => !a.startsWith("--") && !(showAt >= 0 && !argv[showAt].includes("=") && i === showAt + 1));
  if (!id || (showAt >= 0 && !show) || !EntryId.safeParse(id).success) {
    console.error("usage: history <entryId> [--show <timestamp>]");
    process.exit(1);
  }
  const domain = id.split("-")[1];
  if (show) {
    const text = readVersion(roots, domain, id, show);
    if (text === null) {
      console.error(`no single version of ${id} matches ${show} (run \`history ${id}\` to list)`);
      process.exit(1);
    }
    process.stdout.write(text);
    return;
  }
  const versions = listVersions(roots, domain, id);
  if (!versions.length) console.log(`no earlier versions of ${id}`);
  for (const v of versions) console.log(`${v.timestamp}  ${String(v.size).padStart(7)}B  ${v.firstLine}`);
}

const USAGE =
  "Usage: wolfpack-kb <command>\n" +
  "  status | sweep [--drain] | reindex | rebuild-vectors | reorg [domain] [--dry-run] [--resummarize-all] | rebuild <domain> (--dry-run | --yes) [--from-current|--from-scratch] [--allow-collapse] [--apply-cross-moves] | rebuild --restore <ts> --yes\n" +
  "  retire <entryId...> [--reason=…] [--dry-run] [--force: anchored entries]\n" +
  "  unpark [<wolf>/<file> | <wolf> | --all | --list] | history <entryId> [--show <timestamp>]";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // No implicit default: a bare `wolfpack-kb` used to run a full sweep +
  // reorg against whatever KB_BASE/KB_OPS the shell had, which is how a
  // mirror got written to by accident. Every caller names its command.
  const cmd = argv[0];
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.error(USAGE);
    process.exit(cmd ? 0 : 2);
  }
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
    case "history":
      await cmdHistory();
      break;
    default:
      console.error(`Unknown command: ${cmd}.\n${USAGE}`);
      process.exit(1);
  }
}

// Drop a held lock on interruption so a Ctrl-C never wedges future sweeps.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (activeRoots) releaseOwnedLock(activeRoots);
    process.exit(130);
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
