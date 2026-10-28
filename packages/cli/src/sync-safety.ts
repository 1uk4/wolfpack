/**
 * Sync safety: catch a harness bundle that crashes before it takes a wolf down.
 *
 *  (a) smokeCheckBundle: run the freshly built harness.cjs locally in a child
 *      node process in smoke mode (`--smoke`: every module loads, nothing is
 *      constructed, prints "ok", exits). A bundle that throws at load, or hangs,
 *      fails here, before anything is uploaded.
 *  (b) watchAfterRestart: after the remote restart, poll the wolf's status; a
 *      crash loop (restarts climbing, or never staying active) triggers a
 *      rollback to the previous bundle the agent kept (harness.prev.cjs).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { fileURLToPath } from "node:url";

export interface SmokeResult {
  ok: boolean;
  /** The bundle's own output (tail), for the error message. */
  output: string;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Load the built bundle in a child node process in smoke mode. The child gets a
 * minimal environment (no wolf secrets) and the repo's node_modules, which is
 * where the bundle's externals (grammy, the Agent SDK) resolve from on the host.
 */
export function smokeCheckBundle(
  harnessPath: string,
  opts: { timeoutMs?: number; nodePath?: string } = {},
): Promise<SmokeResult> {
  return runSmoke(harnessPath, ["--smoke"], {
    cwd: path.dirname(harnessPath),
    env: { WOLF_HARNESS_SMOKE: "1" },
    timeoutMs: opts.timeoutMs ?? 20_000,
    nodePath: opts.nodePath,
  });
}

function runSmoke(
  harnessPath: string,
  args: string[],
  o: { cwd: string; env: Record<string, string>; timeoutMs: number; nodePath?: string },
): Promise<SmokeResult> {
  const timeoutMs = o.timeoutMs;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [harnessPath, ...args], {
      cwd: o.cwd,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        NODE_PATH: o.nodePath ?? path.join(repoRoot, "node_modules"),
        ...o.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    const collect = (d: Buffer) => { output = (output + d.toString()).slice(-4000); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const said = output.split("\n").some((l) => l.trim() === "ok");
      if (timedOut) resolve({ ok: false, output: `${output}\n(smoke check timed out after ${timeoutMs}ms)`.trim() });
      else resolve({ ok: code === 0 && said, output });
    });
  });
}

/** The pieces of a built bundle the start smoke needs. */
export interface BuiltBundleFiles {
  harnessPath: string;
  wolfYamlPath: string;
  modelsPath: string;
  agentsMdPath: string;
  /** Holds extensions/<name>/index.js. */
  tmpDir: string;
}

/**
 * Start smoke (a, deeper): run createWolfHarness from the built bundle against a throwaway copy of the wolf's home
 * (<tmp>/{wolf.yaml, models.json, agent/AGENTS.md, den/extensions/*}), so a throw during startup (config, model
 * selection, extensions, storage, root conversation) fails the sync, not the VPS. Safe by construction: no telegram
 * (extension and block removed), no sandbox, no librarian sweep, memory.enabled false (no timers, no KB/Work writes),
 * no real credentials, empty KB/Work env. The throwaway home is deleted afterwards.
 */
export async function smokeStartBundle(built: BuiltBundleFiles, opts: { timeoutMs?: number; nodePath?: string; expectBridge?: boolean } = {}): Promise<SmokeResult> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wolfpack-smoke-home-"));
  try {
    const cfg = (yamlParse(fs.readFileSync(built.wolfYamlPath, "utf8")) ?? {}) as Record<string, unknown>;
    delete cfg.telegram;
    delete cfg.sandbox;
    if (Array.isArray(cfg.extensions)) cfg.extensions = (cfg.extensions as string[]).filter((e) => e !== "telegram");
    cfg.memory = { ...((cfg.memory as object) ?? {}), enabled: false, librarian: false, live: false };
    fs.writeFileSync(path.join(home, "wolf.yaml"), yamlStringify(cfg));
    fs.copyFileSync(built.modelsPath, path.join(home, "models.json"));
    fs.mkdirSync(path.join(home, "agent"), { recursive: true });
    fs.copyFileSync(built.agentsMdPath, path.join(home, "agent", "AGENTS.md"));
    const den = path.join(home, "den");
    fs.mkdirSync(den, { recursive: true });
    const extSrc = path.join(built.tmpDir, "extensions");
    if (fs.existsSync(extSrc)) fs.cpSync(extSrc, path.join(den, "extensions"), { recursive: true });
    const res = await runSmoke(built.harnessPath, [], {
      cwd: home,
      env: {
        HOME: home,
        WOLF_DEN: den,
        WOLF_HARNESS_SMOKE: "start",
        // Dummies so the subscription/api checks pass; nothing calls a model.
        CLAUDE_CODE_OAUTH_TOKEN: "smoke-check",
        ANTHROPIC_API_KEY: "smoke-check",
      },
      timeoutMs: opts.timeoutMs ?? 30_000,
      nodePath: opts.nodePath,
    });
    // On subscription the main agent must come up on the bridge: a silent fallback to the API key fails the smoke.
    if (res.ok && opts.expectBridge && !res.output.includes("Main agent via Max subscription (claude-bridge)")) {
      return { ok: false, output: `${res.output}\n(expected the main agent on the claude-bridge provider, but it fell back to the API key)`.trim() };
    }
    return res;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** What the agent's status endpoint returns that this needs. */
export interface WolfWatchClient {
  wolfStatus(nameOrId: string): Promise<unknown>;
  rollbackWolf(nameOrId: string): Promise<unknown>;
}

export type WatchVerdict =
  | { ok: true }
  | { ok: false; reason: string; rolledBack: boolean; rollbackError?: string };

interface WatchOpts {
  /** The wolf's restart count before the update (undefined: an agent that does not report it). */
  baseline?: number;
  timeoutMs?: number;
  intervalMs?: number;
  /** How long it must stay active without a restart to count as healthy. */
  stableMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const statusOf = (s: unknown): { state?: string; restarts?: number } => {
  const o = (s ?? {}) as { serviceState?: unknown; restarts?: unknown };
  return {
    state: typeof o.serviceState === "string" ? o.serviceState : undefined,
    restarts: typeof o.restarts === "number" ? o.restarts : undefined,
  };
};

/** Poll the wolf after a restart; on a crash loop, roll back to the previous bundle. */
export async function watchAfterRestart(client: WolfWatchClient, wolfId: string, opts: WatchOpts = {}): Promise<WatchVerdict> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const stableMs = opts.stableMs ?? 10_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const start = now();
  let activeSince: number | undefined;
  let last = "no status";

  const fail = async (reason: string): Promise<WatchVerdict> => {
    try {
      await client.rollbackWolf(wolfId);
      return { ok: false, reason, rolledBack: true };
    } catch (err) {
      return { ok: false, reason, rolledBack: false, rollbackError: err instanceof Error ? err.message : String(err) };
    }
  };

  while (now() - start < timeoutMs) {
    await sleep(intervalMs);
    let s: { state?: string; restarts?: number };
    try {
      s = statusOf(await client.wolfStatus(wolfId));
    } catch (err) {
      last = `status unreachable: ${err instanceof Error ? err.message : err}`;
      activeSince = undefined;
      continue;
    }
    last = `${s.state ?? "unknown"}${s.restarts !== undefined ? `, ${s.restarts} restarts` : ""}`;
    if (s.restarts !== undefined && opts.baseline !== undefined && s.restarts > opts.baseline) {
      return fail(`crash-looping: restarts ${opts.baseline} → ${s.restarts}`);
    }
    if (s.state === "failed") return fail("the service failed");
    if (s.state === "active") {
      activeSince ??= now();
      if (now() - activeSince >= stableMs) return { ok: true };
    } else {
      activeSince = undefined;
    }
  }
  // Out of time: active now (but not yet for long) is fine; anything else is not.
  if (activeSince !== undefined) return { ok: true };
  return fail(`not active ${Math.round(timeoutMs / 1000)}s after the restart (${last})`);
}
