/**
 * wolfpack models [wolf] [--host <host>] [--json]
 *
 * Prints a wolf's resolved model table: every model use (main agent, each
 * engine step, each repo subagent) with its tier, model, thinking level and
 * where each value came from (pack / wolf), plus the resolver's warnings.
 * With no wolf, prints every local wolf and every VPS wolf.
 *
 * Also home to the live model list `wolfpack config` validates against.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse as yamlParse } from "yaml";
import {
  KNOWN_MODELS,
  ModelConfigError,
  isTier,
  type ModelTable,
  type Tier,
  type Transport,
} from "@wolfpack/engine";
import { AgentClient } from "../agent-client.js";
import { allBackends } from "../backend/index.js";
import { loadConfig, getHost, localWolfDir, LOCAL_HOST, type CliConfig } from "../config.js";
import { extensionsDir } from "../extensions.js";
import { resolveLocalWolfModels, resolveRemoteWolfModels } from "../models.js";
import { c, table as renderTable } from "../render.js";

const execFileAsync = promisify(execFile);

// ── Rows ─────────────────────────────────────────────────────────────────────

/** A subagent definition in the repo and the raw value of its `model:` key. */
export interface AgentModelRef {
  name: string;
  /** Extension package the agent file lives in (e.g. wolfpack-subagents). */
  extension: string;
  model: string | undefined;
  /** The agent file. */
  path?: string;
  /** Where it lives (default repo). Precedence: repo < wolf < project. */
  origin?: AgentOrigin;
  /** Set when this agent overrides a repo agent of the same name: the repo file it shadows. */
  shadows?: string;
}

export type AgentOrigin = "repo" | "wolf" | "project";

export interface ModelRow {
  use: string;
  /** The tier, or "—" when an agent file names something that isn't one. */
  tier: string;
  model: string;
  thinking: string;
  source: string;
}

function readAgentFile(file: string, extension: string, origin: AgentOrigin): AgentModelRef {
  const raw = fs.readFileSync(file, "utf8");
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const meta = (fm ? yamlParse(fm[1]!) : undefined) as { name?: unknown; model?: unknown } | undefined;
  return {
    name: typeof meta?.name === "string" ? meta.name : path.basename(file).replace(/\.md$/, ""),
    extension,
    model: typeof meta?.model === "string" ? meta.model : undefined,
    path: file,
    origin,
  };
}

/** Read the agent files (*.md) directly in a dir — a wolf's agent/agents or a project's .pi/agents. */
export function readAgentsDir(dir: string, origin: AgentOrigin): AgentModelRef[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const out: AgentModelRef[] = [];
  for (const f of files) {
    try {
      out.push(readAgentFile(path.join(dir, f), origin, origin));
    } catch {
      /* unreadable agent file */
    }
  }
  return out;
}

/**
 * The agents a wolf actually gets: repo agents, overridden by same-named wolf
 * agents, overridden by same-named project agents (the subagents extension's
 * precedence). An override records the lower-precedence file it shadows.
 */
export function effectiveAgents(repo: AgentModelRef[], wolf: AgentModelRef[], project: AgentModelRef[]): AgentModelRef[] {
  const byName = new Map<string, AgentModelRef>();
  for (const layer of [repo, wolf, project]) {
    for (const a of layer) {
      const prev = byName.get(a.name);
      byName.set(a.name, prev ? { ...a, shadows: prev.shadows ?? prev.path } : a);
    }
  }
  return [...byName.values()];
}

/** Repo agents plus this wolf's and the project's (cwd) overrides and additions. */
export function agentsForWolf(repo: AgentModelRef[], wolfAgentDir: string | undefined, cwd: string = process.cwd()): AgentModelRef[] {
  return effectiveAgents(
    repo,
    wolfAgentDir ? readAgentsDir(path.join(wolfAgentDir, "agents"), "wolf") : [],
    readAgentsDir(path.join(cwd, ".pi", "agents"), "project"),
  );
}

/** Read every repo subagent file (extensions/*\/agents/*.md) and its `model:`. */
export function readRepoAgents(dir: string = extensionsDir()): AgentModelRef[] {
  const agents: AgentModelRef[] = [];
  let exts: string[] = [];
  try {
    exts = fs.readdirSync(dir).sort();
  } catch {
    return agents;
  }
  for (const ext of exts) {
    const agentsDir = path.join(dir, ext, "agents");
    let files: string[];
    try {
      files = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md")).sort();
    } catch {
      continue;
    }
    for (const file of files) agents.push(readAgentFile(path.join(agentsDir, file), ext, "repo"));
  }
  return agents;
}

function tierRow(table: ModelTable, use: string, tier: Tier): ModelRow {
  const t = table.tiers[tier];
  const source =
    t.thinkingSource && t.thinkingSource !== t.modelSource
      ? `model ${t.modelSource}, thinking ${t.thinkingSource}`
      : t.modelSource;
  return { use, tier, model: t.model, thinking: t.thinking ?? "—", source };
}

/** Origin note for an agent that isn't a plain repo agent. */
function agentNote(a: AgentModelRef): string | undefined {
  if (a.shadows) return `⚠ shadows repo agent (${a.shadows})`;
  if (a.origin === "wolf" || a.origin === "project") return `${a.origin} agent (${a.path})`;
  return undefined;
}

/** One row per model use: main, each engine step, each subagent. */
export function modelRows(table: ModelTable, agents: AgentModelRef[]): ModelRow[] {
  const rows: ModelRow[] = [tierRow(table, "main", "main")];
  for (const [step, { tier }] of Object.entries(table.steps)) rows.push(tierRow(table, step, tier));
  for (const agent of agents) {
    const use = `agent:${agent.name}`;
    const note = agentNote(agent);
    if (isTier(agent.model)) {
      const row = tierRow(table, use, agent.model);
      rows.push(note ? { ...row, source: `${row.source}; ${note}` } : row);
    } else {
      rows.push({
        use,
        tier: "—",
        model: `${agent.model ?? "(none)"} (not a tier)`,
        thinking: "—",
        source: note ?? `${agent.extension}/agents`,
      });
    }
  }
  return rows;
}

export function formatModelRows(rows: ModelRow[]): string {
  return renderTable(
    ["USE", "TIER", "MODEL", "THINKING", "SOURCE"],
    rows.map((r) => [r.use, r.tier, r.model, r.thinking, r.source]),
  );
}

// ── Command ──────────────────────────────────────────────────────────────────

interface WolfRef {
  name: string;
  /** "local" or a registered host name. */
  host: string;
}

type Resolved = { ok: true; table: ModelTable } | { ok: false; error: string };

export async function wolfModels(
  name: string | undefined,
  opts: { host?: string; json?: boolean },
): Promise<void> {
  const config = loadConfig();
  const refs = name ? [await findWolf(config, name, opts.host)] : await allWolves(config);
  if (refs.length === 0) {
    console.log("No wolves found. Run `wolfpack add wolf <name>` to create one.");
    return;
  }

  const repoAgents = readRepoAgents();
  const agentsOf = (r: WolfRef): AgentModelRef[] =>
    r.host === LOCAL_HOST
      ? agentsForWolf(repoAgents, path.join(localWolfDir(config, r.name), "agent"))
      : agentsForWolf(repoAgents, undefined);
  const results: Array<WolfRef & Resolved> = [];
  for (const ref of refs) results.push({ ...ref, ...(await resolveWolf(config, ref)) });

  if (opts.json) {
    const out = results.map((r) =>
      r.ok
        ? { wolf: r.name, host: r.host, table: r.table, rows: modelRows(r.table, agentsOf(r)) }
        : { wolf: r.name, host: r.host, error: r.error },
    );
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  } else {
    for (const r of results) {
      console.log(`\n  ${c.bold(r.name)} ${c.dim(r.host === LOCAL_HOST ? "(local)" : `(${r.host})`)}`);
      if (!r.ok) {
        console.log(c.red(`  ${r.error}`));
        continue;
      }
      console.log(c.dim(`  transport: ${r.table.transport} (${r.table.transportSource})`));
      if (r.table.location === "vps" && r.table.transport === "subscription") {
        // pi-durable has no Max provider for the main agent yet (phase 2).
        console.log(c.dim("  main agent: API key (no Max provider on pi-durable yet); memory + sweep: Max"));
      }
      console.log("");
      console.log(indent(formatModelRows(modelRows(r.table, agentsOf(r))), "  "));
      for (const w of r.table.warnings) console.log(c.yellow(`  ⚠ ${w}`));
    }
    console.log("");
  }
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

function indent(text: string, prefix: string): string {
  return text.split("\n").map((l) => prefix + l).join("\n");
}

async function resolveWolf(config: CliConfig, ref: WolfRef): Promise<Resolved> {
  try {
    if (ref.host === LOCAL_HOST) return { ok: true, table: resolveLocalWolfModels(config, ref.name) };
    const host = getHost(config, ref.host);
    if (!host) return { ok: false, error: `Host '${ref.host}' not found. Run \`wolfpack host list\`.` };
    const status = (await new AgentClient(host).wolfStatus(ref.name)) as {
      config?: { transport?: unknown; models?: unknown };
    };
    return { ok: true, table: resolveRemoteWolfModels(config, status.config) };
  } catch (err) {
    if (err instanceof ModelConfigError) return { ok: false, error: err.message };
    return { ok: false, error: `Failed to resolve: ${err instanceof Error ? err.message : err}` };
  }
}

/** Every local wolf plus every VPS wolf, the way `wolfpack list` finds them. */
async function allWolves(config: CliConfig): Promise<WolfRef[]> {
  const refs: WolfRef[] = [];
  await Promise.all(
    allBackends(config).map(async (backend) => {
      try {
        for (const w of await backend.list()) refs.push({ name: w.name, host: w.host });
      } catch {
        if (backend.host !== LOCAL_HOST) {
          console.error(c.yellow(`  ! ${backend.host}: agent unreachable — its wolves are not shown`));
        }
      }
    }),
  );
  // Local first, then hosts, each alphabetical.
  return refs.sort((a, b) =>
    a.host === b.host
      ? a.name.localeCompare(b.name)
      : a.host === LOCAL_HOST ? -1 : b.host === LOCAL_HOST ? 1 : a.host.localeCompare(b.host),
  );
}

/** Local wolf if it has a wolf.yaml (and no --host); else the first host whose agent knows it. */
async function findWolf(config: CliConfig, name: string, hostFlag?: string): Promise<WolfRef> {
  if (!hostFlag && fs.existsSync(path.join(localWolfDir(config, name), "wolf.yaml"))) {
    return { name, host: LOCAL_HOST };
  }
  const candidates = hostFlag
    ? [hostFlag]
    : [
        ...(config.defaultHost ? [config.defaultHost] : []),
        ...Object.keys(config.hosts).filter((h) => h !== config.defaultHost),
      ];
  for (const hostName of candidates) {
    const host = getHost(config, hostName);
    if (!host) continue;
    try {
      await new AgentClient(host).wolfStatus(name);
      return { name, host: hostName };
    } catch {
      // not on this host (or unreachable)
    }
  }
  throw new Error(`Wolf not found locally or on any host: ${name}`);
}

// ── Live model list (used by `wolfpack config` when saving a model ID) ───────

export interface ModelList {
  ids: string[];
  /** false → the live list couldn't be fetched and `ids` is the engine's KNOWN_MODELS. */
  live: boolean;
  /** Why the live list couldn't be fetched. */
  reason?: string;
}

/** Model IDs on the subscription bridge, from `pi --list-models` output. */
export function parseBridgeModels(output: string): string[] {
  const ids: string[] = [];
  for (const line of output.split("\n")) {
    const [provider, model] = line.trim().split(/\s+/);
    if (provider === "claude-bridge" && model) ids.push(model);
  }
  return ids;
}

/** Value of KEY in a dotenv file (undefined if the file or key is absent). */
export function readEnvValue(file: string, key: string): string | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || m[1] !== key) continue;
    const value = m[2]!.trim().replace(/^(['"])(.*)\1$/, "$2");
    return value || undefined;
  }
  return undefined;
}

async function fetchBridgeModels(): Promise<string[]> {
  // The bridge is installed per wolf (its agent dir), not in ~/.pi/agent, so a
  // plain `pi` from the user's shell lists no claude-bridge models.
  const agentDir = bridgeAgentDir();
  const { stdout } = await execFileAsync("pi", ["--list-models"], {
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
    env: agentDir ? { ...process.env, PI_CODING_AGENT_DIR: agentDir } : process.env,
  });
  const ids = parseBridgeModels(stdout);
  if (ids.length === 0) throw new Error("`pi --list-models` listed no claude-bridge models");
  return ids;
}

/** Agent dir of the first local wolf whose pi settings install pi-claude-bridge. */
function bridgeAgentDir(): string | undefined {
  if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR;
  const localRoot = path.join(loadConfig().wolvesRoot, LOCAL_HOST);
  let names: string[] = [];
  try {
    names = fs.readdirSync(localRoot);
  } catch {
    return undefined;
  }
  for (const name of names) {
    const agentDir = path.join(localRoot, name, "agent");
    try {
      const settings = fs.readFileSync(path.join(agentDir, "settings.json"), "utf8");
      if (settings.includes("pi-claude-bridge")) return agentDir;
    } catch {
      /* not a wolf with pi settings */
    }
  }
  return undefined;
}

async function fetchApiModels(): Promise<string[]> {
  const key = readEnvValue(path.join(os.homedir(), ".wolfpack", ".env"), "ANTHROPIC_API_KEY");
  if (!key) throw new Error("no ANTHROPIC_API_KEY in ~/.wolfpack/.env");
  const ids: string[] = [];
  let after: string | undefined;
  for (;;) {
    const url = new URL("https://api.anthropic.com/v1/models");
    url.searchParams.set("limit", "1000");
    if (after) url.searchParams.set("after_id", after);
    const res = await fetch(url, {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`GET /v1/models returned ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ id: string }>; has_more?: boolean; last_id?: string };
    ids.push(...(body.data ?? []).map((m) => m.id));
    if (!body.has_more || !body.last_id) break;
    after = body.last_id;
  }
  return ids;
}

const listCache = new Map<Transport, Promise<ModelList>>();
const fallbackNoticed = new Set<Transport>();

/** The models available on a transport, falling back to KNOWN_MODELS when the live list can't be fetched. */
export function liveModels(transport: Transport): Promise<ModelList> {
  let cached = listCache.get(transport);
  if (!cached) {
    const fetcher = transport === "subscription" ? fetchBridgeModels : fetchApiModels;
    cached = fetcher().then(
      (ids): ModelList => ({ ids, live: true }),
      (err): ModelList => ({ ids: [...KNOWN_MODELS], live: false, reason: err instanceof Error ? err.message : String(err) }),
    );
    listCache.set(transport, cached);
  }
  return cached;
}

/**
 * Check a model ID against the list for every given transport. Returns an
 * error message when it's missing from one, else undefined. Notes about
 * falling back to KNOWN_MODELS go to `notice`.
 */
export async function checkModelId(
  id: string,
  transports: Transport[],
  notice: (msg: string) => void = (m) => console.log(c.yellow(`  ! ${m}`)),
): Promise<string | undefined> {
  for (const transport of [...new Set(transports)]) {
    const list = await liveModels(transport);
    if (!list.live && !fallbackNoticed.has(transport)) {
      fallbackNoticed.add(transport);
      notice(`Couldn't fetch the ${transport} model list (${list.reason}); checking against the built-in known models instead.`);
    }
    if (!list.ids.includes(id)) {
      return `"${id}" is not in the ${transport} model list${list.live ? "" : " (built-in fallback)"}. Available: ${list.ids
        .filter((m) => m.startsWith("claude-"))
        .join(", ")}`;
    }
  }
  return undefined;
}
