/**
 * wolfpack config [wolf] [--set key=value ...] [--host <host>]
 *
 * No wolf:            edits the pack's `models:` block in ~/.wolfpack/config.yaml
 *                     (tier models, thinking, local/VPS transport defaults).
 * Local  (no --host): reads/writes ~/wolves/<wolf>/wolf.yaml and regenerates
 *                     the PI `.pi/settings.json` when extensions/runtime change.
 * Remote (--host):    talks to the host agent.
 *
 * With no --set on a TTY, enters an interactive editor (domains, extensions,
 * models). Model IDs are checked against the transport's live model list
 * before they're saved.
 */

import fs from "node:fs";
import path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { AgentClient } from "../agent-client.js";
import {
  TIERS,
  TRANSPORTS,
  THINKING_LEVELS,
  ModelConfigError,
  resolveModelTable,
  type PackModels,
  type Tier,
  type TierSetting,
  type Transport,
  type WolfLocation,
  type WolfModels,
} from "@wolfpack/engine";
import { loadConfig, getHost, localWolfDir, savePackModels } from "../config.js";
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
import { checkModelId } from "./wolf-models.js";

const TELEGRAM_TOKEN_ENV = "TELEGRAM_BOT_TOKEN";

interface WolfYaml {
  id: string;
  name: string;
  runtime: string;
  profile?: string;
  role?: string;
  specialty?: string;
  domains?: string[];
  extensions?: string[];
  telegram?: { tokenEnv: string; ownerId: number };
  transport?: string;
  models?: WolfModels["models"];
  [k: string]: unknown;
}

/** Keys that used to pick a model; models are configured per tier now. */
const REMOVED_KEYS = ["model", "provider"];

function parseSets(sets: string[]): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  for (const kv of sets) {
    const eq = kv.indexOf("=");
    if (eq < 0) {
      console.error(c.red(`Invalid format: ${kv} (expected key=value)`));
      process.exit(1);
    }
    const key = kv.slice(0, eq);
    if (REMOVED_KEYS.includes(key) || key === "memory.model" || key === "memory.fastModel") {
      console.error(c.red(`'${key}' is no longer a setting. Use models.<main|smart|fast>.model / .thinking and transport.`));
      process.exit(1);
    }
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

/** Recursively merge plain objects (arrays and scalars replace). */
export function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(out[k], v);
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export async function wolfConfig(
  nameOrId: string | undefined,
  opts: { host?: string; set?: string[] },
): Promise<void> {
  if (!nameOrId) {
    await configPack(opts);
    return;
  }
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
    const updates = parseSets(opts.set);
    const merged = deepMerge(wolf, updates) as WolfYaml;
    if ("models" in updates || "transport" in updates) {
      await validateWolfModelsOrExit(wolfModelsOf(merged), "local");
    }
    persistLocal(wolfDir, yamlPath, merged);
    console.log(c.green(`✓ Updated ${name}`));
    console.log(c.dim(yamlStringify(merged)));
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
  console.log(c.dim(`  models:     ${modelsSummary(wolfModelsOf(wolf), "local")}`));
  console.log(c.dim(`  domains:    ${wolf.domains?.join(", ") || "(none)"}`));
  console.log(c.dim(`  extensions: ${wolf.extensions?.join(", ") || "(none)"}\n`));

  const section = await select<string>("What do you want to configure?", [
    { label: "Domains", value: "domains" },
    { label: "Extensions", value: "extensions" },
    { label: "Models (transport, tier overrides)", value: "models" },
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
    case "models": {
      const edited = await editWolfModels(wolfModelsOf(wolf), "local");
      if (!edited) {
        console.log(c.dim("No changes."));
        return;
      }
      if (edited.transport === undefined) delete wolf.transport;
      else wolf.transport = edited.transport;
      if (edited.models === undefined) delete wolf.models;
      else wolf.models = edited.models;
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
    transport?: string;
    models?: WolfModels["models"];
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
    // The agent merges one level deep; pre-merge models so a single
    // models.<tier>.<key> doesn't drop the tier's other key.
    if (isPlainObject(updates.models)) updates.models = deepMerge(cfg.models ?? {}, updates.models);
    if ("models" in updates || "transport" in updates) {
      await validateWolfModelsOrExit(
        {
          transport: (updates.transport ?? cfg.transport) as string | undefined,
          models: (updates.models ?? cfg.models) as WolfModels["models"],
        },
        "vps",
      );
    }
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
  const remoteModels: WolfModels = { transport: cfg.transport, models: cfg.models ?? undefined };
  console.log(c.dim(`  models:     ${modelsSummary(remoteModels, "vps")}`));
  console.log(c.dim(`  domains:    ${cfg.domains?.join(", ") || "(none)"}`));
  console.log(c.dim(`  extensions: ${cfg.extensions?.join(", ") || "(none)"}\n`));

  const section = await select<string>("What do you want to configure?", [
    { label: "Domains", value: "domains" },
    { label: "Extensions", value: "extensions" },
    { label: "Models (transport, tier overrides)", value: "models" },
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
    case "models": {
      const edited = await editWolfModels(remoteModels, "vps");
      if (!edited) break;
      Object.assign(updates, remoteModelUpdates(edited));
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
      const shown = Array.isArray(v) ? v.join(", ") : v && typeof v === "object" ? JSON.stringify(v) : v;
      console.log(c.dim(`  ${k}: ${shown}`));
    }
    console.log(c.yellow(`  Run \`wolfpack sync ${nameOrId}\` to rebuild and deploy.`));
  } catch (err) {
    console.error(c.red(`Failed: ${err}`));
    process.exit(1);
  }
}

// ── Models ───────────────────────────────────────────────────────────────────

type TierOverrides = NonNullable<WolfModels["models"]>;

function wolfModelsOf(wolf: { transport?: unknown; models?: unknown }): WolfModels {
  return {
    transport: typeof wolf.transport === "string" ? wolf.transport : undefined,
    models: isPlainObject(wolf.models) ? (wolf.models as TierOverrides) : undefined,
  };
}

/**
 * Set (value) or clear (undefined) one key of a tier override. Empty tiers
 * and an empty block collapse to undefined so clearing deletes the key.
 */
export function setTierOverride(
  models: TierOverrides | undefined,
  tier: Tier,
  key: keyof TierSetting,
  value: string | undefined,
): TierOverrides | undefined {
  const next: TierOverrides = { ...(models ?? {}) };
  const setting: TierSetting = { ...(next[tier] ?? {}) };
  if (value === undefined || value === "") delete setting[key];
  else setting[key] = value;
  if (Object.keys(setting).length === 0) delete next[tier];
  else next[tier] = setting;
  return Object.keys(next).length === 0 ? undefined : next;
}

/**
 * Agent PATCH body for a wolf's model keys. The agent shallow-merges one
 * level, so every tier is sent (null clears it) and a cleared key is null.
 */
export function remoteModelUpdates(models: WolfModels): Record<string, unknown> {
  const tiers = models.models;
  return {
    transport: models.transport ?? null,
    models: tiers ? Object.fromEntries(TIERS.map((t) => [t, tiers[t] ?? null])) : null,
  };
}

function isTransport(v: unknown): v is Transport {
  return typeof v === "string" && (TRANSPORTS as readonly string[]).includes(v);
}

/** One-line summary of the resolved models for the menu header. */
function modelsSummary(wolf: WolfModels, location: WolfLocation): string {
  try {
    const t = resolveModelTable({ pack: loadConfig().models, wolf, location });
    const tiers = TIERS.map((tier) => {
      const r = t.tiers[tier];
      return `${tier} ${r.model}${r.thinking ? `:${r.thinking}` : ""}${r.modelSource === "wolf" || r.thinkingSource === "wolf" ? "*" : ""}`;
    });
    return `${t.transport} · ${tiers.join(" · ")}${tiers.some((x) => x.endsWith("*")) ? "  (* = wolf override)" : ""}`;
  } catch (err) {
    return err instanceof ModelConfigError ? "(pack models: not configured — run `wolfpack config`)" : String(err);
  }
}

/** Model IDs in a wolf's overrides that aren't on its transport's list (messages). */
async function wolfModelErrors(wolf: WolfModels, location: WolfLocation): Promise<string[]> {
  const pack = loadConfig().models;
  const transport = isTransport(wolf.transport) ? wolf.transport : pack?.transport?.[location];
  if (wolf.transport !== undefined && !isTransport(wolf.transport)) {
    return [`transport must be ${TRANSPORTS.join("|")} (got "${wolf.transport}")`];
  }
  if (!isTransport(transport)) {
    return [`pack models.transport.${location} isn't set — configure the pack first: wolfpack config`];
  }
  const errors: string[] = [];
  for (const tier of TIERS) {
    const setting = wolf.models?.[tier];
    const model = setting?.model?.trim();
    if (model) {
      const err = await checkModelId(model, [transport]);
      if (err) errors.push(`${tier}: ${err}`);
    }
    if (setting?.thinking && !(THINKING_LEVELS as readonly string[]).includes(setting.thinking)) {
      errors.push(`${tier}: thinking must be one of ${THINKING_LEVELS.join("|")} (got "${setting.thinking}")`);
    }
  }
  return errors;
}

async function validateWolfModelsOrExit(wolf: WolfModels, location: WolfLocation): Promise<void> {
  const errors = await wolfModelErrors(wolf, location);
  if (errors.length === 0) return;
  for (const e of errors) console.error(c.red(`✗ ${e}`));
  process.exit(1);
}

async function pickThinking(label: string, current: string | undefined, inheritLabel: string): Promise<string | undefined> {
  const keep = "__keep";
  const unset = "__unset";
  const choice = await select<string>(`${label} thinking`, [
    { label: `keep (${current ?? inheritLabel})`, value: keep },
    ...THINKING_LEVELS.map((l) => ({ label: l, value: l as string })),
    { label: `unset (${inheritLabel})`, value: unset },
  ]);
  if (choice === keep) return current;
  if (choice === unset) return undefined;
  return choice;
}

/**
 * Interactive editor for a wolf's transport and per-tier overrides.
 * Returns the edited keys, or undefined when cancelled / nothing changed.
 */
async function editWolfModels(current: WolfModels, location: WolfLocation): Promise<WolfModels | undefined> {
  const pack = loadConfig().models;
  if (!pack) {
    console.log(c.yellow("The pack has no models: block yet. Run `wolfpack config` (no wolf) to set the pack tiers first."));
    return undefined;
  }
  let edited: WolfModels = { transport: current.transport, models: current.models };
  const packTransport = pack.transport?.[location] ?? "(unset)";

  for (;;) {
    const choice = await select<string>(`Models (${location} wolf; pack transport default: ${packTransport})`, [
      { label: `Transport: ${edited.transport ? `${edited.transport} (wolf)` : `${packTransport} (pack)`}`, value: "transport" },
      ...TIERS.map((tier) => {
        const o = edited.models?.[tier];
        const p = pack[tier];
        const model = o?.model ? `${o.model} (wolf)` : `${p?.model ?? "(unset)"} (pack)`;
        const thinking = o?.thinking ? `${o.thinking} (wolf)` : p?.thinking ? `${p.thinking} (pack)` : "default";
        return { label: `${tier}: ${model}, thinking ${thinking}`, value: tier as string };
      }),
      { label: "Save", value: "save" },
      { label: "Cancel", value: "cancel" },
    ]);

    if (choice === "cancel") return undefined;
    if (choice === "save") {
      const errors = await wolfModelErrors(edited, location);
      if (errors.length) {
        for (const e of errors) console.log(c.red(`  ✗ ${e}`));
        continue;
      }
      if (JSON.stringify(edited) === JSON.stringify({ transport: current.transport, models: current.models })) return undefined;
      return edited;
    }
    if (choice === "transport") {
      const t = await select<string>("Transport", [
        { label: `pack default (${packTransport})`, value: "__pack" },
        ...TRANSPORTS.map((x) => ({ label: x, value: x as string })),
      ]);
      edited = { ...edited, transport: t === "__pack" ? undefined : t };
      continue;
    }

    const tier = choice as Tier;
    const override = edited.models?.[tier];
    const packModel = pack[tier]?.model ?? "(unset)";
    const answer = await prompt(
      `${tier} model override — model ID, '-' to clear, enter to keep (pack: ${packModel}; now: ${override?.model ?? "none"})`,
    );
    let models = edited.models;
    if (answer === "-") models = setTierOverride(models, tier, "model", undefined);
    else if (answer) models = setTierOverride(models, tier, "model", answer);
    const thinking = await pickThinking(
      tier,
      models?.[tier]?.thinking,
      pack[tier]?.thinking ? `pack: ${pack[tier]!.thinking}` : "model default",
    );
    models = setTierOverride(models, tier, "thinking", thinking);
    edited = { ...edited, models };
  }
}

/** Model IDs in the pack block that aren't on every default transport's list (messages). */
async function packModelErrors(pack: PackModels): Promise<string[]> {
  const errors: string[] = [];
  const transports: Transport[] = [];
  for (const loc of ["local", "vps"] as const) {
    const t = pack.transport?.[loc];
    if (isTransport(t)) transports.push(t);
    else errors.push(`transport.${loc} must be ${TRANSPORTS.join("|")} (got ${JSON.stringify(t)})`);
  }
  for (const tier of TIERS) {
    const setting = pack[tier];
    const model = setting?.model?.trim();
    if (!model) errors.push(`${tier}: a model is required`);
    else if (transports.length) {
      const err = await checkModelId(model, transports);
      if (err) errors.push(`${tier}: ${err}`);
    }
    if (setting?.thinking && !(THINKING_LEVELS as readonly string[]).includes(setting.thinking)) {
      errors.push(`${tier}: thinking must be one of ${THINKING_LEVELS.join("|")} (got "${setting.thinking}")`);
    }
  }
  return errors;
}

/** `wolfpack config` with no wolf: the pack's `models:` block. */
async function configPack(opts: { set?: string[] }): Promise<void> {
  const config = loadConfig();
  const current: PackModels = config.models ?? {};

  if (opts.set && opts.set.length > 0) {
    const updates = parseSets(opts.set);
    const other = Object.keys(updates).filter((k) => k !== "models");
    if (other.length) {
      console.error(c.red(`Without a wolf, only models.* can be set (got: ${other.join(", ")}).`));
      process.exit(1);
    }
    const next = deepMerge(current, updates.models) as PackModels;
    const errors = await packModelErrors(next);
    if (errors.length) {
      for (const e of errors) console.error(c.red(`✗ ${e}`));
      process.exit(1);
    }
    savePackModels(next);
    console.log(c.green("✓ Updated pack models"));
    console.log(c.dim(yamlStringify({ models: next })));
    return;
  }

  if (!process.stdin.isTTY) {
    console.log(yamlStringify({ models: config.models ?? null }));
    return;
  }

  console.log(c.bold("\nPack models (~/.wolfpack/config.yaml)"));
  console.log(c.dim("  Tiers every wolf uses unless its wolf.yaml overrides them. Configure a wolf: wolfpack config <wolf>\n"));

  let edited: PackModels = JSON.parse(JSON.stringify(current)) as PackModels;
  for (;;) {
    const choice = await select<string>("Pack models", [
      ...TIERS.map((tier) => ({
        label: `${tier}: ${edited[tier]?.model ?? "(unset)"}, thinking ${edited[tier]?.thinking ?? "default"}`,
        value: tier as string,
      })),
      { label: `Transport for local wolves: ${edited.transport?.local ?? "(unset)"}`, value: "local" },
      { label: `Transport for VPS wolves: ${edited.transport?.vps ?? "(unset)"}`, value: "vps" },
      { label: "Save", value: "save" },
      { label: "Cancel", value: "cancel" },
    ]);

    if (choice === "cancel") {
      console.log(c.dim("No changes."));
      return;
    }
    if (choice === "save") {
      const errors = await packModelErrors(edited);
      if (errors.length) {
        for (const e of errors) console.log(c.red(`  ✗ ${e}`));
        continue;
      }
      savePackModels(edited);
      console.log(c.green("\n✓ Saved pack models"));
      console.log(c.yellow("  Local wolves pick this up on their next launch; VPS wolves on their next `wolfpack sync`."));
      return;
    }
    if (choice === "local" || choice === "vps") {
      const t = await select<string>(
        `Transport for ${choice === "local" ? "local" : "VPS"} wolves`,
        TRANSPORTS.map((x) => ({ label: x, value: x as string })),
      );
      edited = { ...edited, transport: { ...edited.transport, [choice]: t } };
      continue;
    }

    const tier = choice as Tier;
    const setting: TierSetting = { ...(edited[tier] ?? {}) };
    const model = await prompt(`${tier} model ID`, setting.model);
    if (model) setting.model = model;
    const thinking = await pickThinking(tier, setting.thinking, "model default");
    if (thinking) setting.thinking = thinking;
    else delete setting.thinking;
    edited = { ...edited, [tier]: setting };
  }
}
