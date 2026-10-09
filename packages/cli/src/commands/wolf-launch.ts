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

/** True when the wolf's agent dir holds a Claude subscription OAuth login
 *  (auth.json → anthropic.type === "oauth"), i.e. it runs on the bridge and must
 *  not be handed a billable ANTHROPIC_API_KEY. */
function hasSubscriptionOAuth(agentDirPath: string): boolean {
  try {
    const auth = JSON.parse(
      fs.readFileSync(path.join(agentDirPath, "auth.json"), "utf8"),
    );
    return auth?.anthropic?.type === "oauth";
  } catch {
    return false;
  }
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

  // When a local wolf is logged into the Claude subscription (OAuth in its
  // auth.json), it runs on the subscription bridge — the main agent via the
  // bridge provider, and memory/subagents over the same transport. A raw
  // ANTHROPIC_API_KEY in the env would override that and silently bill the API,
  // so strip it here. The key stays in ~/.wolfpack/.env purely so VPS
  // provisioning (`wolfpack add wolf --host …`, which reads your shell env) can
  // ship it to remote wolves — the local agent never uses it.
  if (hasSubscriptionOAuth(agentDir(wolfDir))) {
    delete env.ANTHROPIC_API_KEY;
    console.log(
      c.dim("Local wolf on Claude subscription (OAuth) — API key withheld."),
    );
  } else if (!env.ANTHROPIC_API_KEY) {
    console.error(
      c.yellow(
        "⚠ No subscription login and no ANTHROPIC_API_KEY — the agent has no credentials.",
      ),
    );
    console.error(
      c.dim("  Run `/login` inside pi for the subscription, or add ANTHROPIC_API_KEY to ~/.wolfpack/.env."),
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
