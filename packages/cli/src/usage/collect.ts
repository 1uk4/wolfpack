/**
 * Usage sources on this machine, one per file:
 *   <root>/local/<wolf>/agent/sessions/**\/*.jsonl — pi session files (local wolves)
 *   <root>/<host>/<wolf>/den/session.sqlite       — mirrored pi-durable stores (VPS wolves)
 *   <den>/usage/<YYYY-MM>.jsonl                   — engine usage logs (both)
 * Read-only throughout; never touches a remote host.
 */
import fs from "node:fs";
import path from "node:path";
import { parse as yamlParse } from "yaml";
import type { UsageEvent, UsageSource } from "@wolfpack/engine";
import { readDurableStore } from "./read-durable.js";
import { engineLogFiles, readEngineLog } from "./read-engine.js";
import { findSessionFiles, readPiSessionFile, sessionUse } from "./read-pi.js";

export interface CollectOptions {
  wolvesRoot: string;
  /** Registered VPS host names (their mirrors live at <root>/<host>). */
  hosts: string[];
  localHost?: string;
  /** Only this wolf. */
  wolf?: string;
}

export interface SourceFile {
  kind: UsageSource;
  wolf: string;
  host: string;
  /** The file to read. */
  file: string;
  /** Files whose size + mtime tell whether the source changed (a store's -wal too). */
  watch: string[];
  /** pi: `main`, `subagent` or `subagent:<agent>`. */
  use?: string;
}

export interface SourceReport {
  /** Session files, per local wolf. */
  pi: Record<string, number>;
  /** VPS wolves with a durable store. */
  durable: string[];
  /** Dens with an engine usage log (`<host>/<wolf>`). */
  engineDens: string[];
  /** Why a source was skipped. */
  skipped: string[];
}

function subdirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** A local wolf's name from its wolf.yaml (undefined: not a wolf dir). */
function localWolfName(dir: string): string | undefined {
  try {
    const w = yamlParse(fs.readFileSync(path.join(dir, "wolf.yaml"), "utf8")) as { name?: unknown };
    return typeof w?.name === "string" ? w.name : path.basename(dir);
  } catch {
    return undefined;
  }
}

/** Every source file, plus what was skipped (e.g. a host with no mirror). */
export function listSources(opts: CollectOptions): { sources: SourceFile[]; skipped: string[] } {
  const sources: SourceFile[] = [];
  const skipped: string[] = [];
  const engine = (den: string, host: string, wolf: string): void => {
    for (const file of engineLogFiles(den)) sources.push({ kind: "engine", wolf, host, file, watch: [file] });
  };

  const localHost = opts.localHost ?? "local";
  const localRoot = path.join(opts.wolvesRoot, localHost);
  for (const dirName of subdirs(localRoot)) {
    const dir = path.join(localRoot, dirName);
    const wolf = localWolfName(dir);
    if (!wolf || (opts.wolf && wolf !== opts.wolf)) continue;
    const sf = findSessionFiles(path.join(dir, "agent", "sessions"));
    for (const file of sf.files) {
      const use = sessionUse(file, sf);
      sources.push({ kind: "pi", wolf, host: localHost, file, watch: [file], use });
    }
    engine(path.join(dir, "den"), localHost, wolf);
  }

  for (const host of opts.hosts) {
    const hostDir = path.join(opts.wolvesRoot, host);
    if (!fs.existsSync(hostDir)) {
      skipped.push(`no mirror for host ${host}`);
      continue;
    }
    for (const wolf of subdirs(hostDir)) {
      if (opts.wolf && wolf !== opts.wolf) continue;
      const den = path.join(hostDir, wolf, "den");
      if (!fs.existsSync(den)) continue;
      const store = path.join(den, "session.sqlite");
      if (fs.existsSync(store)) {
        sources.push({ kind: "durable", wolf, host, file: store, watch: [store, `${store}-wal`] });
      }
      engine(den, host, wolf);
    }
  }

  return { sources, skipped };
}

/** Read one source's events. Throws if the file can't be read. */
export async function readSource(src: SourceFile): Promise<UsageEvent[]> {
  switch (src.kind) {
    case "pi":
      return readPiSessionFile(src.file, src.wolf, src.use ?? "main");
    case "durable":
      return readDurableStore(src.file, src.host, src.wolf);
    case "engine":
      return readEngineLog(src.file, src.wolf);
  }
}

/** Summarise a source list for the report footer. */
export function reportSources(sources: SourceFile[], skipped: string[]): SourceReport {
  const report: SourceReport = { pi: {}, durable: [], engineDens: [], skipped: [...skipped] };
  for (const s of sources) {
    if (s.kind === "pi") report.pi[s.wolf] = (report.pi[s.wolf] ?? 0) + 1;
    else if (s.kind === "durable") report.durable.push(s.wolf);
    else if (!report.engineDens.includes(`${s.host}/${s.wolf}`)) report.engineDens.push(`${s.host}/${s.wolf}`);
  }
  return report;
}

/** Read every source live (no ledger). */
export async function collectUsage(opts: CollectOptions): Promise<{ events: UsageEvent[]; sources: SourceReport }> {
  const { sources, skipped } = listSources(opts);
  const events: UsageEvent[] = [];
  const failed: string[] = [];
  for (const src of sources) {
    try {
      for (const e of await readSource(src)) events.push(e);
    } catch (err) {
      failed.push(`${src.host}/${src.wolf} ${src.kind} unreadable: ${(err as Error).message}`);
    }
  }
  return { events, sources: reportSources(sources, [...skipped, ...failed]) };
}
