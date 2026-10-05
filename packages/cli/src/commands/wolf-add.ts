/**
 * wolfpack add wolf <name> [--host <host>]
 *
 * Local (no --host): creates wolf directory in ~/wolves/      → "worker" profile
 * Remote (--host):   sends create request to agent on a host  → "assistant" profile
 *
 * Interactive by default: picks a profile, lets you adjust the attached
 * extensions, and (when Telegram is attached) collects the bot token + owner.
 * Use --yes / flags to skip prompts. Wolfpack only uses the PI runtime.
 */

import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { stringify as yamlStringify } from "yaml";
import { AgentClient } from "../agent-client.js";
import { buildRemoteBundle } from "../bundle.js";
import { ensureDenMirror } from "./host-sync.js";
import { loadConfig, getHost, localWolfDir, sharedDir } from "../config.js";
import { c } from "../render.js";
import { multiSelect, prompt } from "../prompts.js";
import {
  AVAILABLE_EXTENSIONS,
  defaultProfile,
  defaultExtensionKeys,
  needsTelegram,
  writePiSettings,
  type WolfProfile,
} from "../extensions.js";

const TELEGRAM_TOKEN_ENV = "TELEGRAM_BOT_TOKEN";

interface AddWolfOpts {
  host?: string;
  model?: string;
  role?: string;
  specialty?: string;
  domains?: string[];
  /** Profile override: worker | assistant */
  profile?: string;
  /** Explicit extension keys (bypasses the interactive picker) */
  extensions?: string[];
  /** Telegram bot token (else prompted when Telegram is attached) */
  telegramToken?: string;
  /** Telegram owner user id (else prompted when Telegram is attached) */
  telegramOwner?: number;
  /** Skip all interactive prompts, use defaults */
  yes?: boolean;
}

interface TelegramChoice {
  tokenEnv: string;
  ownerId: number;
  token: string;
}

interface ResolvedChoices {
  runtime: string;
  profile: WolfProfile;
  extensions: string[];
  telegram?: TelegramChoice;
}

/** Decide profile, extensions, and Telegram config. PI only. */
async function resolveChoices(opts: AddWolfOpts): Promise<ResolvedChoices> {
  const interactive = !opts.yes && process.stdin.isTTY;
  const runtime = "pi"; // Wolfpack only supports the PI runtime for now.
  const profile: WolfProfile =
    opts.profile === "assistant" || opts.profile === "worker"
      ? opts.profile
      : defaultProfile(!!opts.host);

  // Extensions
  let extensions: string[];
  if (opts.extensions) {
    extensions = opts.extensions;
  } else if (interactive) {
    const seed = defaultExtensionKeys(profile);
    extensions = await multiSelect<string>(
      `Select extensions to attach (${profile} profile)`,
      AVAILABLE_EXTENSIONS.map((e) => ({
        label: `${e.label} — ${e.description}`,
        value: e.key,
        selected: seed.includes(e.key),
      })),
    );
  } else {
    extensions = defaultExtensionKeys(profile);
  }

  // Telegram config (only if the telegram extension is attached)
  let telegram: TelegramChoice | undefined;
  if (needsTelegram(extensions)) {
    const token =
      opts.telegramToken ??
      (interactive
        ? await prompt("Telegram bot token (from @BotFather)")
        : "");
    const ownerRaw =
      opts.telegramOwner !== undefined
        ? String(opts.telegramOwner)
        : interactive
          ? await prompt("Telegram owner user id")
          : "";
    telegram = {
      tokenEnv: TELEGRAM_TOKEN_ENV,
      ownerId: parseInt(ownerRaw, 10) || 0,
      token,
    };
  }

  return { runtime, profile, extensions, telegram };
}

export async function wolfAdd(name: string, opts: AddWolfOpts): Promise<void> {
  const choices = await resolveChoices(opts);
  if (opts.host) {
    await addRemote(name, opts, choices);
  } else {
    addLocal(name, opts, choices);
  }
}

/** Create wolf locally in ~/wolves/ */
function addLocal(
  name: string,
  opts: AddWolfOpts,
  choices: ResolvedChoices,
): void {
  const config = loadConfig();
  const id = nanoid(6);
  const wolfDir = localWolfDir(config, name);

  if (fs.existsSync(wolfDir)) {
    console.error(c.red(`Wolf directory already exists: ${wolfDir}`));
    process.exit(1);
  }

  console.log(c.bold(`Creating local wolf: ${name} (${id})`));

  const dirs = ["den", "den/memory", "den/tasks", "logs"];
  for (const dir of dirs) {
    fs.mkdirSync(path.join(wolfDir, dir), { recursive: true });
  }

  // Write wolf.yaml
  const wolfConfig: Record<string, unknown> = {
    id,
    name,
    runtime: choices.runtime,
    profile: choices.profile,
    model: opts.model ?? "claude-sonnet-4-6",
    role: opts.role ?? name,
    specialty: opts.specialty,
    domains: opts.domains ?? [],
    extensions: choices.extensions,
  };
  if (choices.telegram) {
    wolfConfig.telegram = {
      tokenEnv: choices.telegram.tokenEnv,
      ownerId: choices.telegram.ownerId,
    };
  }
  fs.writeFileSync(path.join(wolfDir, "wolf.yaml"), yamlStringify(wolfConfig));

  // Write .env — memory extension reads WOLF_DEN; librarian points at shared/.
  // ANTHROPIC_API_KEY is expected from your shell environment.
  const denPath = path.join(wolfDir, "den");
  const librarianInbox = path.join(sharedDir(config), "librarian", "inbox");
  const envLines = [
    `WOLF_ID=${id}`,
    `WOLF_NAME=${name}`,
    `WOLF_DEN=${denPath}`,
    `WOLFPACK_LIBRARIAN=${librarianInbox}`,
  ];
  if (choices.telegram?.token) {
    envLines.push(`${choices.telegram.tokenEnv}=${choices.telegram.token}`);
  }
  fs.writeFileSync(path.join(wolfDir, ".env"), envLines.join("\n") + "\n", {
    mode: 0o600,
  });

  // Wire up PI extensions
  const missing = writePiSettings(wolfDir, choices.extensions);

  reportCreated(wolfDir, id, choices, missing);
  console.log(c.dim(`  Config:  ${path.join(wolfDir, "wolf.yaml")}`));
}

/** Create wolf on a remote host via agent */
async function addRemote(
  name: string,
  opts: AddWolfOpts,
  choices: ResolvedChoices,
): Promise<void> {
  const config = loadConfig();
  const host = getHost(config, opts.host);

  if (!host) {
    console.error(
      c.red(`Host '${opts.host}' not found. Run \`wolfpack host list\`.`),
    );
    process.exit(1);
  }

  console.log(c.bold(`Creating wolf '${name}' on ${opts.host}...`));

  const model = opts.model ?? "claude-sonnet-4-6";

  // Build the portable identity bundle (single source of truth) locally.
  console.log(c.dim("Building identity bundle (extensions + settings)..."));
  const built = await buildRemoteBundle({
    name,
    role: opts.role ?? name,
    specialty: opts.specialty,
    domains: opts.domains ?? [],
    extensions: choices.extensions,
  });
  if (built.missing.length) {
    console.log(
      c.yellow(`  ! Skipped (not vendored in repo): ${built.missing.join(", ")}`),
    );
  }

  // Secrets + runtime env shipped to the agent to write into the wolf's .env.
  const env: Record<string, string> = {};
  if (choices.telegram?.token) env[choices.telegram.tokenEnv] = choices.telegram.token;
  if (choices.telegram?.ownerId) env.TELEGRAM_OWNER_ID = String(choices.telegram.ownerId);
  const providerKey = process.env.ANTHROPIC_API_KEY;
  if (providerKey) env.ANTHROPIC_API_KEY = providerKey;
  env.WOLFPACK_LIBRARIAN = path.join(sharedDir(config), "librarian", "inbox");

  const client = new AgentClient(host);
  try {
    const result = (await client.createWolf({
      name,
      runtime: choices.runtime,
      profile: choices.profile,
      model,
      role: opts.role ?? name,
      specialty: opts.specialty,
      domains: opts.domains ?? [],
      extensions: built.included,
      telegram: choices.telegram
        ? { tokenEnv: choices.telegram.tokenEnv, ownerId: choices.telegram.ownerId }
        : undefined,
      env: Object.keys(env).length ? env : undefined,
      bundle: built.bundleB64,
      bundleManifest: built.manifest,
    })) as { wolf: { id: string; name: string } };

    console.log(c.green(`✓ Wolf created on ${opts.host}`));
    console.log(c.dim(`  ID:      ${result.wolf.id}`));
    console.log(c.dim(`  Name:    ${result.wolf.name}`));
    console.log(c.dim(`  Profile: ${choices.profile}`));
    console.log(
      c.dim(
        `  Exts:    ${built.manifest.extensions
          .map((e) => `${e.key}@${e.version}`)
          .join(", ") || "(none)"}`,
      ),
    );

    // Auto-wire the den backup mirror (best-effort; host must be Syncthing-ready).
    try {
      const { macDen } = await ensureDenMirror(opts.host!, host, result.wolf);
      console.log(c.dim(`  Mirror:  ${macDen}`));
    } catch (err) {
      console.log(
        c.yellow(
          `  ! Den mirror not wired (${err instanceof Error ? err.message : err}). Run: wolfpack host sync ${opts.host}`,
        ),
      );
    }
  } catch (err) {
    console.error(c.red(`Failed: ${err}`));
    process.exit(1);
  }
}

function reportCreated(
  wolfDir: string,
  id: string,
  choices: ResolvedChoices,
  missing: string[],
): void {
  console.log(c.green(`✓ Wolf created at ${wolfDir}`));
  console.log(c.dim(`  ID:      ${id}`));
  console.log(c.dim(`  Runtime: pi`));
  console.log(c.dim(`  Profile: ${choices.profile}`));
  console.log(
    c.dim(
      `  Exts:    ${choices.extensions.length ? choices.extensions.join(", ") : "(none)"}`,
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
