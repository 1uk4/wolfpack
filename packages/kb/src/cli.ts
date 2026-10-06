#!/usr/bin/env node
/**
 * wolfpack-kb — Dewey's KB engine CLI. Driven by a systemd timer (see
 * infra/roles/kb-sweep) so sweeps run whether or not Dewey is mid-conversation.
 *
 * Commands:
 *   sweep             drain inboxes → route → produce → commit → fan-out
 *   rebuild-vectors   wipe + re-embed the entry-vector cache (model change etc.)
 *
 * Environment:
 *   ANTHROPIC_API_KEY     — required (the oracles + produce call)
 *   WOLFPACK_MODEL        — smart model for produce (default: claude-sonnet-4-6)
 *   WOLFPACK_FAST_MODEL   — fast model for oracles (default: claude-haiku-4-5-20251001)
 *   KB_BASE               — knowledge/base root (default: ~/knowledge/base)
 *   KB_OPS                — librarian-ops root (default: ~/librarian)
 *   WOLF_DEN              — den root; den-local KB state lives at $WOLF_DEN/kb
 *   WOLFPACK_EMBED_URL    — Ollama URL (default: http://127.0.0.1:11434)
 *   WOLFPACK_EMBED_MODEL  — embedding model (default: nomic-embed-text)
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { rmSync, existsSync, readdirSync } from "node:fs";
import { createEngine } from "@wolfpack/engine";
import type { KbRoots } from "./shared/index.js";
import { vectorsDir } from "./shared/index.js";
import {
  sweep,
  readLedger,
  foldRegistry,
  createEmbedder,
  buildEntryVectors,
} from "./librarian/index.js";

function resolveRoots(): KbRoots {
  const home = homedir();
  const denRoot = process.env.WOLF_DEN ?? join(home, "wolves", "den");
  return {
    kbBase: resolve(process.env.KB_BASE ?? join(home, "knowledge", "base")),
    opsRoot: resolve(process.env.KB_OPS ?? join(home, "librarian")),
    // den-local KB state (ledger/vectors). Overridable so it can live outside
    // the (user-owned, synced) den when the sweep runs as root.
    denLocal: resolve(process.env.KB_DEN_LOCAL ?? join(denRoot, "kb")),
  };
}

function makeEngine() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is required");
    process.exit(1);
  }
  const defaultModel = process.env.WOLFPACK_MODEL ?? "claude-sonnet-4-6";
  const fastModel =
    process.env.WOLFPACK_FAST_MODEL ?? "claude-haiku-4-5-20251001";
  return createEngine({
    provider: "anthropic",
    apiKey,
    defaultModel,
    steps: {
      // Entries (esp. merges) produce large JSON; the 4096 default truncates it
      // and breaks JSON extraction (same lesson as the memory consolidator).
      produce: { model: defaultModel, maxTokens: 16000 },
      contradict: { model: fastModel },
      classifyEntry: { model: fastModel },
      labelTopic: { model: fastModel },
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

async function cmdSweep(): Promise<void> {
  const roots = resolveRoots();
  const engine = makeEngine();
  const embedder = createEmbedder(roots);

  // Announce only when there's actually work; keeps the 15-min timer quiet.
  const pending = countPending(roots.opsRoot);
  if (pending.total > 0) {
    await tg(
      `\u{1F9F9} *Dewey KB sweep* starting \u2014 ${pending.total} pending ` +
        `contribution(s) from ${pending.wolves.join(", ")}\u2026`
    );
  }

  const result = await sweep({
    engine,
    roots,
    loadEntryVectors: () =>
      buildEntryVectors(roots, foldRegistry(readLedger(roots)), embedder),
    notify: (msg) => console.log(msg),
  });

  console.log(
    `done: ${result.processed} processed · ${result.created}c ${result.merged}m ` +
      `${result.rejected}r · ${result.crystallized} crystallized · ${result.fed} fed`
  );
  console.log(engine.usage.summarize());

  if (result.processed > 0) {
    const u = engine.usage.summarize();
    await tg(
      [
        `\u2705 *Dewey KB sweep* complete`,
        `\u2022 processed: ${result.processed}`,
        `\u2022 created: ${result.created}  merged: ${result.merged}  rejected: ${result.rejected}  errors: ${result.errors}`,
        `\u2022 crystallized: ${result.crystallized}  fed: ${result.fed}`,
        `\u2022 tokens: ${u.totalTokens}`,
      ].join("\n")
    );
  }
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

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "sweep";
  switch (cmd) {
    case "sweep":
      await cmdSweep();
      break;
    case "rebuild-vectors":
      await cmdRebuildVectors();
      break;
    default:
      console.error(`Unknown command: ${cmd}. Use: sweep | rebuild-vectors`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
