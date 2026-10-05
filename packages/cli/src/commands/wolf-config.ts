/**
 * wolfpack config <wolf> [--set key=value ...] [--host <host>]
 *
 * Local  (no --host): reads/writes ~/wolves/<wolf>/wolf.yaml and regenerates
 *                     the PI `.pi/settings.json` when extensions/runtime change.
 * Remote (--host):    talks to the host agent.
 *
 * With no --set on a TTY, enters an interactive editor (runtime + extensions).
 */

import fs from "node:fs";
import path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { AgentClient } from "../agent-client.js";
import { loadConfig, getHost, localWolfDir } from "../config.js";
import { c } from "../render.js";
import { multiSelect, prompt } from "../prompts.js";
import {
  AVAILABLE_EXTENSIONS,
  defaultExtensionKeys,
  needsTelegram,
  writePiSettings,
} from "../extensions.js";

const TELEGRAM_TOKEN_ENV = "TELEGRAM_BOT_TOKEN";

interface WolfYaml {
  id: string;
  name: string;
  runtime: string;
  profile?: string;
  model?: string;
  role?: string;
  specialty?: string;
  domains?: string[];
  extensions?: string[];
  telegram?: { tokenEnv: string; ownerId: number };
  [k: string]: unknown;
}

function parseSets(sets: string[]): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  for (const kv of sets) {
    const eq = kv.indexOf("=");
    if (eq < 0) {
      console.error(c.red(`Invalid format: ${kv} (expected key=value)`));
      process.exit(1);
    }
    const key = kv.slice(0, eq);
    const val = kv.slice(eq + 1);
    if (key === "domains" || key === "extensions") {
      updates[key] = val.split(",").map((s) => s.trim()).filter(Boolean);
    } else {
      updates[key] = val;
    }
  }
  return updates;
}

export async function wolfConfig(
  nameOrId: string,
  opts: { host?: string; set?: string[] },
): Promise<void> {
  if (opts.host) {
    await configRemote(nameOrId, opts);
  } else {
    await configLocal(nameOrId, opts);
  }
}

/** Local wolf config in ~/wolves/<name>/wolf.yaml */
async function configLocal(
  name: string,
  opts: { set?: string[] },
): Promise<void> {
  const wolfDir = localWolfDir(loadConfig(), name);
  const yamlPath = path.join(wolfDir, "wolf.yaml");

  if (!fs.existsSync(yamlPath)) {
    console.error(c.red(`Local wolf not found: ${wolfDir}`));
    console.error(c.dim("  (use --host <host> for remote wolves)"));
    process.exit(1);
  }

  const wolf = yamlParse(fs.readFileSync(yamlPath, "utf8")) as WolfYaml;

  // Scripted update
  if (opts.set && opts.set.length > 0) {
    Object.assign(wolf, parseSets(opts.set));
    persistLocal(wolfDir, yamlPath, wolf);
    console.log(c.green(`✓ Updated ${name}`));
    console.log(c.dim(yamlStringify(wolf)));
    return;
  }

  // Non-TTY: just print
  if (!process.stdin.isTTY) {
    console.log(yamlStringify(wolf));
    return;
  }

  // Interactive editor (PI only)
  console.log(c.bold(`\nConfiguring ${name} (${wolf.id})`));
  console.log(c.dim(yamlStringify(wolf)));

  wolf.runtime = "pi";
  const profile = (wolf.profile as string) ?? "worker";
  const current = wolf.extensions ?? defaultExtensionKeys(
    profile === "assistant" ? "assistant" : "worker",
  );
  wolf.extensions = await multiSelect<string>(
    "Select extensions to attach",
    AVAILABLE_EXTENSIONS.map((e) => ({
      label: `${e.label} — ${e.description}`,
      value: e.key,
      selected: current.includes(e.key),
    })),
  );

  // Collect Telegram config if newly attached and not configured yet
  if (needsTelegram(wolf.extensions) && !wolf.telegram) {
    const owner = await prompt("Telegram owner user id");
    wolf.telegram = {
      tokenEnv: TELEGRAM_TOKEN_ENV,
      ownerId: parseInt(owner, 10) || 0,
    };
    const token = await prompt("Telegram bot token (blank to set later in .env)");
    if (token) upsertEnv(wolfDir, TELEGRAM_TOKEN_ENV, token);
  } else if (!needsTelegram(wolf.extensions)) {
    delete wolf.telegram;
  }

  const missing = persistLocal(wolfDir, yamlPath, wolf);
  console.log(c.green(`\n✓ Updated ${name}`));
  console.log(
    c.dim(
      `  Exts:    ${wolf.extensions?.length ? wolf.extensions.join(", ") : "(none)"}`,
    ),
  );
  if (missing.length) {
    console.log(
      c.yellow(
        `  ⚠ Not installed: ${missing.join(", ")} (no package under extensions/)`,
      ),
    );
  }
}

/** Insert or update a KEY=value line in the wolf's .env file. */
function upsertEnv(wolfDir: string, key: string, value: string): void {
  const envPath = path.join(wolfDir, ".env");
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(envPath, "utf8").split("\n").filter(Boolean);
  } catch {
    // new file
  }
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (idx >= 0) lines[idx] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  fs.writeFileSync(envPath, lines.join("\n") + "\n", { mode: 0o600 });
}

function persistLocal(
  wolfDir: string,
  yamlPath: string,
  wolf: WolfYaml,
): string[] {
  fs.writeFileSync(yamlPath, yamlStringify(wolf));
  if (wolf.runtime === "pi") {
    return writePiSettings(wolfDir, wolf.extensions ?? []);
  }
  return [];
}

/** Remote wolf config via agent */
async function configRemote(
  nameOrId: string,
  opts: { host?: string; set?: string[] },
): Promise<void> {
  const config = loadConfig();
  const host = getHost(config, opts.host);

  if (!host) {
    console.error(c.red("No host specified and no default host set."));
    process.exit(1);
  }

  const client = new AgentClient(host);

  if (!opts.set || opts.set.length === 0) {
    try {
      const status = await client.wolfStatus(nameOrId);
      console.log(JSON.stringify(status, null, 2));
    } catch (err) {
      console.error(c.red(`Failed: ${err}`));
      process.exit(1);
    }
    return;
  }

  const updates = parseSets(opts.set);

  try {
    console.log(`Updating ${nameOrId} config...`);
    const result = (await client.updateWolfConfig(nameOrId, updates)) as {
      wolf: Record<string, unknown>;
    };
    console.log(c.green(`✓ Config updated and wolf restarted`));
    console.log(c.dim(JSON.stringify(result.wolf, null, 2)));
  } catch (err) {
    console.error(c.red(`Failed: ${err}`));
    process.exit(1);
  }
}
