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
import { loadRegistry, listDomainNames } from "../domains.js";
import { c } from "../render.js";
import { select, multiSelect, prompt } from "../prompts.js";
import {
  AVAILABLE_EXTENSIONS,
  defaultExtensionKeys,
  extensionSupportsRuntime,
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
    let val: string | boolean | number | string[] = kv.slice(eq + 1);
    
    // Handle arrays for domains/extensions
    if (key === "domains" || key === "extensions") {
      updates[key] = val.split(",").map((s) => s.trim()).filter(Boolean);
      continue;
    }
    
    // Type coercion
    if (val === "true") val = true;
    else if (val === "false") val = false;
    else if (/^\d+$/.test(val)) val = parseInt(val, 10);
    else if (/^\d+\.\d+$/.test(val)) val = parseFloat(val);
    
    // Handle dot notation (e.g., memory.librarian=true)
    if (key.includes(".")) {
      const parts = key.split(".");
      let current = updates;
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (!current[part] || typeof current[part] !== "object") {
          current[part] = {};
        }
        current = current[part] as Record<string, unknown>;
      }
      current[parts[parts.length - 1]] = val;
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
    return;
  }
  
  // Try local first, fall back to remote
  const config = loadConfig();
  const wolfDir = localWolfDir(config, nameOrId);
  if (fs.existsSync(path.join(wolfDir, "wolf.yaml"))) {
    await configLocal(nameOrId, opts);
    return;
  }
  
  // Not local — try to find on default host
  const hostName = config.defaultHost;
  if (hostName) {
    const host = getHost(config, hostName);
    if (host) {
      await configRemote(nameOrId, { ...opts, host: hostName });
      return;
    }
  }
  
  console.error(c.red(`Wolf not found locally or on default host: ${nameOrId}`));
  process.exit(1);
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

  // Interactive menu
  console.log(c.bold(`\nConfiguring ${name} (${wolf.id})`));
  console.log(c.dim(`  runtime:    ${wolf.runtime || "pi"}`));
  console.log(c.dim(`  model:      ${wolf.model || "(default)"}`));
  console.log(c.dim(`  domains:    ${wolf.domains?.join(", ") || "(none)"}`));
  console.log(c.dim(`  extensions: ${wolf.extensions?.join(", ") || "(none)"}\n`));

  const section = await select<string>("What do you want to configure?", [
    { label: "Domains", value: "domains" },
    { label: "Extensions", value: "extensions" },
    { label: "Model", value: "model" },
  ]);

  switch (section) {
    case "domains": {
      const reg = loadRegistry();
      const allDomains = listDomainNames(reg);
      if (allDomains.length === 0) {
        console.log(c.dim("No domains declared. Create one: wolfpack add domain <name>"));
        break;
      }
      wolf.domains = await multiSelect<string>(
        "Select domains",
        allDomains.map((d) => ({
          label: d,
          value: d,
          selected: (wolf.domains ?? []).includes(d),
        })),
      );
      break;
    }
    case "extensions": {
      const runtime = wolf.runtime || "pi";
      const profile = (wolf.profile as string) ?? "worker";
      const current = wolf.extensions ?? defaultExtensionKeys(
        profile === "assistant" ? "assistant" : "worker",
      );
      const pickable = AVAILABLE_EXTENSIONS.filter((e) => {
        if (!extensionSupportsRuntime(e, runtime)) return false;
        if (e.librarian) return false;
        return true;
      });
      wolf.extensions = await multiSelect<string>(
        `Select extensions (${runtime} runtime)`,
        pickable.map((e) => ({
          label: `${e.label} — ${e.description}`,
          value: e.key,
          selected: current.includes(e.key),
        })),
      );

      if (wolf.extensions?.includes("memory")) {
        const mem = wolf.memory as Record<string, unknown> | undefined;
        if (mem?.librarian) {
          wolf.extensions.push("kb");
        }
      } else {
        delete wolf.memory;
      }

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
      break;
    }
    case "model": {
      const current = (wolf.model as string) || "";
      const newModel = await prompt("Model ID", current);
      if (newModel) wolf.model = newModel;
      break;
    }
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
interface RemoteWolfStatus {
  id: string;
  name: string;
  runtime: string;
  config?: {
    model?: string;
    domains?: string[];
    extensions?: string[];
    profile?: string;
    memory?: Record<string, unknown>;
    telegram?: { tokenEnv: string; ownerId: number };
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

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

  let status: RemoteWolfStatus;
  try {
    status = (await client.wolfStatus(nameOrId)) as RemoteWolfStatus;
  } catch (err) {
    console.error(c.red(`Failed to reach ${nameOrId}: ${err}`));
    process.exit(1);
  }

  const cfg = status.config;
  if (!cfg) {
    console.error(c.red(`Agent did not return config for '${nameOrId}'.`));
    process.exit(1);
  }

  // Scripted update
  if (opts.set && opts.set.length > 0) {
    const updates = parseSets(opts.set);
    try {
      const result = (await client.updateWolfConfig(nameOrId, updates)) as {
        wolf: Record<string, unknown>;
      };
      console.log(c.green(`\u2713 Config updated`));
      console.log(c.dim(JSON.stringify(result.wolf, null, 2)));
    } catch (err) {
      console.error(c.red(`Failed: ${err}`));
      process.exit(1);
    }
    return;
  }

  // Non-TTY: dump JSON
  if (!process.stdin.isTTY) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  // Interactive menu
  const runtime = (cfg.runtime as string) || "pi-durable";
  const hostName = opts.host ?? config.defaultHost ?? "remote";

  console.log(c.bold(`\nConfiguring ${cfg.name ?? nameOrId} (${status.id}) on ${hostName}`));
  console.log(c.dim(`  runtime:    ${runtime}`));
  console.log(c.dim(`  model:      ${cfg.model || "(default)"}`));
  console.log(c.dim(`  domains:    ${cfg.domains?.join(", ") || "(none)"}`));
  console.log(c.dim(`  extensions: ${cfg.extensions?.join(", ") || "(none)"}\n`));

  const section = await select<string>("What do you want to configure?", [
    { label: "Domains", value: "domains" },
    { label: "Extensions", value: "extensions" },
    { label: "Model", value: "model" },
  ]);

  const updates: Record<string, unknown> = {};

  switch (section) {
    case "domains": {
      const reg = loadRegistry();
      const allDomains = listDomainNames(reg);
      if (allDomains.length === 0) {
        console.log(c.dim("No domains declared. Create one: wolfpack add domain <name>"));
        return;
      }
      updates.domains = await multiSelect<string>(
        "Select domains",
        allDomains.map((d) => ({
          label: d,
          value: d,
          selected: (cfg.domains ?? []).includes(d),
        })),
      );
      break;
    }
    case "extensions": {
      const pickable = AVAILABLE_EXTENSIONS.filter((e) => {
        if (!extensionSupportsRuntime(e, runtime)) return false;
        if (e.librarian) return false;
        return true;
      });
      const chosen = await multiSelect<string>(
        `Select extensions (${runtime} runtime)`,
        pickable.map((e) => ({
          label: `${e.label} \u2014 ${e.description}`,
          value: e.key,
          selected: (cfg.extensions ?? []).includes(e.key),
        })),
      );
      // Preserve librarian kb extension if configured
      if (cfg.memory?.librarian && !chosen.includes("kb")) {
        chosen.push("kb");
      }
      updates.extensions = chosen;
      break;
    }
    case "model": {
      const newModel = await prompt("Model ID", cfg.model || "");
      if (newModel) updates.model = newModel;
      break;
    }
  }

  if (Object.keys(updates).length === 0) {
    console.log(c.dim("No changes."));
    return;
  }

  try {
    await client.updateWolfConfig(nameOrId, updates);
    console.log(c.green(`\u2713 Config updated on ${hostName}`));
    for (const [k, v] of Object.entries(updates)) {
      console.log(c.dim(`  ${k}: ${Array.isArray(v) ? v.join(", ") : v}`));
    }
    console.log(c.yellow(`  Run \`wolfpack sync ${nameOrId}\` to rebuild and deploy.`));
  } catch (err) {
    console.error(c.red(`Failed: ${err}`));
    process.exit(1);
  }
}
