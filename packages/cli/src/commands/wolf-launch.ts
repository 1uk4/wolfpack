/**
 * wolfpack launch <wolf> [dir] — run Pi *as* the wolf in a project directory.
 *
 * The wolf is a Pi identity, not a working directory: we point
 * PI_CODING_AGENT_DIR at the wolf's agent dir (its extensions, persona,
 * sessions) and load its env, then exec `pi` in your current directory (or
 * the given project dir). So you work in real projects while the wolf's
 * memory/extensions/identity come along.
 *
 * Remote wolves are not launched from the CLI — they run 24/7 on their host
 * and you reach them via Telegram.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { parse as yamlParse } from "yaml";
import { ModelConfigError, MODELS_FILE_ENV, piModelArg, writeModelTable, type ModelTable } from "@wolfpack/engine";
import { loadConfig, getHost, localWolfDir } from "../config.js";
import { agentDir, writePiModelDefaults } from "../extensions.js";
import { MODELS_FILE_NAME, resolveLocalWolfModels } from "../models.js";
import { c } from "../render.js";

/** Parse a minimal KEY=VALUE .env file (ignores blanks and # comments). */
function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export async function wolfLaunch(
  name: string,
  opts: { host?: string; dir?: string; session?: string },
): Promise<void> {
  const config = loadConfig();

  const wolfDir = localWolfDir(config, name);
  const yamlPath = path.join(wolfDir, "wolf.yaml");
  const existsLocally = fs.existsSync(yamlPath);

  // A wolf is "remote" only when it doesn't live locally. The default host is
  // irrelevant for launching a wolf that exists on this machine — it's the
  // host for *remote* operations, not a reason to reject a local wolf.
  // Only reject if the user explicitly targeted a remote host, or the wolf
  // can't be found locally and a remote host is configured.
  const explicitHost = opts.host && opts.host !== "local";
  if (!existsLocally) {
    const hostName = opts.host ?? config.defaultHost;
    if (hostName && hostName !== "local" && getHost(config, hostName)) {
      console.error(
        c.yellow(
          `'${name}' is on ${hostName}. Remote wolves run 24/7 on their host and are reached via Telegram, not launched from the CLI.`,
        ),
      );
      process.exit(1);
    }
    console.error(c.red(`Local wolf not found: ${wolfDir}`));
    console.error(c.dim(`  create it with: wolfpack add wolf ${name}`));
    process.exit(1);
  }

  // Guard against explicitly asking to launch a wolf *on* a remote host.
  if (explicitHost && getHost(config, opts.host)) {
    console.error(
      c.yellow(
        `'${name}' was requested on ${opts.host}. Remote wolves run 24/7 on their host and are reached via Telegram, not launched from the CLI.`,
      ),
    );
    process.exit(1);
  }

  const wolf = yamlParse(fs.readFileSync(yamlPath, "utf8")) as {
    id: string;
    name: string;
    runtime: string;
  };

  // Working directory = the project you want to work in (default: cwd).
  // NOT the wolf dir " that stays the wolf's identity/knowledge home.
  const workDir = opts.dir ? path.resolve(opts.dir) : process.cwd();
  if (!fs.existsSync(workDir)) {
    console.error(c.red(`Project directory not found: ${workDir}`));
    process.exit(1);
  }

  // Resolve the wolf's model table once for the whole session: written to
  // <wolfDir>/models.json and handed to pi, memory and subagents through
  // WOLFPACK_MODELS_FILE. Unknown IDs only warn; missing config aborts.
  let table: ModelTable;
  try {
    table = resolveLocalWolfModels(config, name);
  } catch (err) {
    if (err instanceof ModelConfigError) {
      console.error(c.red(err.message));
      process.exit(1);
    }
    throw err;
  }
  for (const w of table.warnings) console.error(c.yellow(`⚠ models: ${w}`));
  const modelsFile = path.join(wolfDir, MODELS_FILE_NAME);
  writeModelTable(modelsFile, table);
  writePiModelDefaults(wolfDir, table.tiers.main);

  // Env precedence: process env < global secrets < per-wolf .env.
  // PI_CODING_AGENT_DIR makes Pi load the wolf's identity (extensions,
  // persona, sessions) regardless of the working directory.
  const globalEnv = parseEnvFile(path.join(os.homedir(), ".wolfpack", ".env"));
  const wolfEnv = parseEnvFile(path.join(wolfDir, ".env"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...globalEnv,
    ...wolfEnv,
    PI_CODING_AGENT_DIR: agentDir(wolfDir),
    [MODELS_FILE_ENV]: modelsFile,
  };

  // A wolf on the subscription transport runs everything over the bridge —
  // the main agent via the bridge provider, memory/subagents via the Agent
  // SDK. A raw ANTHROPIC_API_KEY in the env would override that and silently
  // bill the API, so strip it here. The key stays in ~/.wolfpack/.env purely
  // so VPS provisioning (`wolfpack add wolf --host …`, which reads your shell
  // env) can ship it to remote wolves — the local agent never uses it.
  if (table.transport === "subscription") {
    delete env.ANTHROPIC_API_KEY;
    console.log(c.dim("Local wolf on the Claude subscription — API key withheld."));
  } else if (!env.ANTHROPIC_API_KEY) {
    console.error(
      c.yellow("⚠ transport: api but no ANTHROPIC_API_KEY — the agent has no credentials."),
    );
    console.error(c.dim("  Add ANTHROPIC_API_KEY to ~/.wolfpack/.env (or the wolf's .env)."));
  }

  // Pi-durable wolves run the harness directly
  if (wolf.runtime === "pi-durable") {
    const harnessEntry = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "../../../harness/dist/bin/harness.js",
    );
    if (!fs.existsSync(harnessEntry)) {
      console.error(c.red(`Harness not built. Run: pnpm build`));
      process.exit(1);
    }
    console.log(c.dim(`Launching ${wolf.name} (pi-durable) in ${workDir}...`));
    const child = spawn("node", [harnessEntry], {
      cwd: workDir,
      env: { ...env, WOLF_DEN: path.join(wolfDir, "den") },
      stdio: "inherit",
    });
    child.on("error", (err) => {
      console.error(c.red(`Failed to launch harness: ${err.message}`));
      process.exit(1);
    });
    child.on("exit", (code) => process.exit(code ?? 0));
    return;
  }

  const mainModel = piModelArg(table.tiers.main);
  console.log(
    c.dim(`Launching as ${wolf.name} (${wolf.id}) on ${mainModel} in ${workDir}...`),
  );

  // --session resumes a specific pi session (file or partial UUID) as this wolf.
  const piArgs = ["--model", mainModel, ...(opts.session ? ["--session", opts.session] : [])];
  const child = spawn("pi", piArgs, {
    cwd: workDir,
    env,
    stdio: "inherit",
  });

  // Restore the terminal to a sane state. Pi normally does this itself on a
  // clean exit, but if it crashes, is killed by a signal, or exits uncleanly
  // (e.g. a broken `/end`), it leaves mouse tracking and the kitty keyboard
  // protocol enabled — the terminal then echoes escape sequences and input
  // looks broken. These sequences are idempotent, so running them after a
  // clean exit is a harmless no-op.
  let restored = false;
  const restoreTerminal = (): void => {
    if (restored) return;
    restored = true;
    if (!process.stdout.isTTY) return;
    process.stdout.write(
      // leave alt screen, show cursor, disable bracketed paste
      "\x1b[?1049l\x1b[?25h\x1b[?2004l" +
        // disable mouse reporting (normal, button, any, SGR)
        "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l" +
        // pop kitty keyboard protocol flags + legacy disable
        "\x1b[<u\x1b[=0u",
    );
  };

  child.on("error", (err: NodeJS.ErrnoException) => {
    restoreTerminal();
    if (err.code === "ENOENT") {
      console.error(c.red("`pi` not found on PATH. Install the PI coding agent."));
    } else {
      console.error(c.red(`Failed to launch pi: ${err.message}`));
    }
    process.exit(1);
  });

  // Forward termination signals to the child so it can try its own cleanup,
  // then restore the terminal ourselves as a backstop.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      try {
        child.kill(sig);
      } catch {
        /* child already gone */
      }
    });
  }

  child.on("exit", (code, signal) => {
    restoreTerminal();
    if (signal) {
      // Re-raise so our exit status reflects the signal.
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}
