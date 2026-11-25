/**
 * wolfpack add wolf <name> [--host <host>]
 *
 * Local (no --host): creates wolf directory in ~/wolves/      → "worker" profile
 * Remote (--host):   sends create request to agent on a host  → "assistant" profile
 *
 * Interactive by default: picks a profile, lets you adjust the attached
 * extensions, and (when Telegram is attached) collects the bot token + owner.
 * Use --yes / flags to skip prompts. Wolves run as pi-durable under wolfd.
 */

import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { stringify as yamlStringify } from "yaml";
import { loadConfig, localWolfDir, kbBaseDir, librarianDir } from "../config.js";
import { loadRegistry, listDomainNames, unknownDomains } from "../domains.js";
import { c } from "../render.js";
import { select, multiSelect, prompt } from "../prompts.js";
import {
  AVAILABLE_EXTENSIONS,
  defaultProfile,
  defaultExtensionKeys,
  needsTelegram,
  extensionsForRuntime,
  resolveExtensionDirs,
  type WolfProfile,
} from "../extensions.js";

const TELEGRAM_TOKEN_ENV = "TELEGRAM_BOT_TOKEN";

interface AddWolfOpts {
  host?: string;
  runtime?: string;
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
  host?: string;
  runtime: string;
  profile: WolfProfile;
  extensions: string[];
  domains: string[];
  telegram?: TelegramChoice;
}

/**
 * Decide host, runtime, profile, extensions, domains, and Telegram config.
 * No model choice: models come from the pack's tiers (transport from the
 * host's pack default); per-wolf overrides are added later with `wolfpack config`.
 */
async function resolveChoices(opts: AddWolfOpts): Promise<ResolvedChoices> {
  const interactive = !opts.yes && process.stdin.isTTY;
  const config = loadConfig();

  // 1. Host
  let host = opts.host;
  if (!host && interactive) {
    const hostNames = Object.keys(config.hosts);
    const hostOptions: Array<{ label: string; value: string }> = [
      { label: "Local (this machine)", value: "local" },
      ...hostNames.map((h) => ({ label: `${h} (VPS)`, value: h })),
    ];
    host = await select<string>("Where should this wolf run?", hostOptions);
    if (host === "local") host = undefined;
  }

  // 2. Runtime
  // Every wolf runs as pi-durable under wolfd (the terminal pi runtime was removed); `wolfd` is the only other value.
  if (opts.runtime === "pi") {
    console.error(c.red("terminal pi runtime was removed; use pi-durable"));
    process.exit(1);
  }
  const runtime = opts.runtime === "wolfd" ? "wolfd" : "pi-durable";

  const profile: WolfProfile =
    opts.profile === "assistant" || opts.profile === "worker"
      ? opts.profile
      : defaultProfile(!!host);

  // Extensions
  let extensions: string[];
  if (opts.extensions) {
    extensions = opts.extensions;
  } else if (interactive) {
    const seed = defaultExtensionKeys(profile);
    const available = extensionsForRuntime(runtime);
    extensions = await multiSelect<string>(
      `Select extensions (${runtime} runtime)`,
      available.map((e) => ({
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
    if (interactive) {
      console.log(c.bold("\n  Telegram setup"));
      console.log(c.dim("  1. Open @BotFather on Telegram"));
      console.log(c.dim("  2. Send /newbot and follow the prompts"));
      console.log(c.dim("  3. Copy the bot token below"));
      console.log(c.dim("  4. Your user ID: send /start to @userinfobot\n"));
    }
    const token =
      opts.telegramToken ??
      (interactive
        ? await prompt("Telegram bot token")
        : "");
    const ownerRaw =
      opts.telegramOwner !== undefined
        ? String(opts.telegramOwner)
        : interactive
          ? await prompt("Telegram owner user ID (restricts access to you)")
          : "";
    telegram = {
      tokenEnv: TELEGRAM_TOKEN_ENV,
      ownerId: parseInt(ownerRaw, 10) || 0,
      token,
    };
  }

  // Domains \u2014 subscribe the wolf to declared KB domains (like the ext picker).
  const reg = loadRegistry();
  const declared = listDomainNames(reg);
  let domains: string[];
  if (opts.domains) {
    const unknown = unknownDomains(reg, opts.domains);
    if (unknown.length) {
      console.error(
        c.red(`Unknown domain(s): ${unknown.join(", ")}. Declare them first: wolfpack domain add <name>`),
      );
      process.exit(1);
    }
    domains = opts.domains;
  } else if (interactive && declared.length) {
    domains = await multiSelect<string>(
      "Subscribe to KB domains",
      declared.map((d) => ({
        label: `${d} \u2014 ${reg.domains[d]!.label}`,
        value: d,
        selected: false,
      })),
    );
  } else {
    domains = [];
  }

  return { host, runtime, profile, extensions, domains, telegram };
}

export async function wolfAdd(name: string, opts: AddWolfOpts): Promise<void> {
  const choices = await resolveChoices(opts);
  const targetHost = choices.host ?? opts.host;
  if (targetHost) {
    addRemote(name, { ...opts, host: targetHost });
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
    role: opts.role ?? name,
    specialty: opts.specialty,
    domains: choices.domains,
    extensions: choices.extensions,
  };
  if (choices.telegram) {
    wolfConfig.telegram = {
      tokenEnv: choices.telegram.tokenEnv,
      ownerId: choices.telegram.ownerId,
    };
  }
  fs.writeFileSync(path.join(wolfDir, "wolf.yaml"), yamlStringify(wolfConfig));

  // Optional NOTES.md stub — the harness appends it to the system prompt.
  fs.writeFileSync(
    path.join(wolfDir, "den", "NOTES.md"),
    "# Notes\n\n" +
      "<!-- Optional. Anything here is added to this wolf's system prompt:\n" +
      "     standing instructions, owner preferences, working style. Delete if unused. -->\n",
  );

  // Write .env — memory extension reads WOLF_DEN and emits KB contribution
  // deltas to the librarian-ops inbox (KB_OPS), and resolves curated entries
  // from the KB base mirror (KB_BASE). ANTHROPIC_API_KEY is expected from your
  // shell environment.
  const denPath = path.join(wolfDir, "den");
  const envLines = [
    `WOLF_ID=${id}`,
    `WOLF_NAME=${name}`,
    `WOLF_DEN=${denPath}`,
    `KB_BASE=${kbBaseDir(config)}`,
    `KB_OPS=${librarianDir(config)}`,
  ];
  if (choices.telegram?.token) {
    envLines.push(`${choices.telegram.tokenEnv}=${choices.telegram.token}`);
  }
  fs.writeFileSync(path.join(wolfDir, ".env"), envLines.join("\n") + "\n", {
    mode: 0o600,
  });

  const { missing } = resolveExtensionDirs(choices.extensions);
  reportCreated(wolfDir, id, choices, missing);
  console.log(c.dim(`  Config:  ${path.join(wolfDir, "wolf.yaml")}`));
}

/** Remote create is not wired to the pi-durable harness bundle yet. */
function addRemote(name: string, opts: AddWolfOpts): never {
  console.error(
    c.red(
      `Remote wolf add for pi-durable is not supported yet (wolf '${name}' on ${opts.host}). ` +
        "Create the wolf's config on the host, then deploy it with `wolfpack sync <wolf> --host <host>`.",
    ),
  );
  process.exit(1);
}

function reportCreated(
  wolfDir: string,
  id: string,
  choices: ResolvedChoices,
  missing: string[],
): void {
  console.log(c.green(`✓ Wolf created at ${wolfDir}`));
  console.log(c.dim(`  ID:      ${id}`));
  console.log(c.dim(`  Runtime: ${choices.runtime}`));
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
