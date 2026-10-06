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
import { loadConfig, getHost, localWolfDir } from "../config.js";
import { agentDir } from "../extensions.js";
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
  opts: { host?: string; dir?: string },
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
  };

  if (!env.ANTHROPIC_API_KEY) {
    console.error(
      c.yellow(
        "⚠ ANTHROPIC_API_KEY not set — memory/subagents will be degraded.",
      ),
    );
    console.error(
      c.dim("  Set it in your shell, or add it to ~/.wolfpack/.env (shared secret)."),
    );
  }

  console.log(
    c.dim(`Launching as ${wolf.name} (${wolf.id}) in ${workDir}...`),
  );

  const child = spawn("pi", [], {
    cwd: workDir,
    env,
    stdio: "inherit",
  });

  child.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") {
      console.error(c.red("`pi` not found on PATH. Install the PI coding agent."));
    } else {
      console.error(c.red(`Failed to launch pi: ${err.message}`));
    }
    process.exit(1);
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}
