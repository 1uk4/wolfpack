/**
 * Model resolution — the single source of truth for which model each use runs.
 *
 * Models are named by tier (main / smart / fast). Configuration lives in two
 * places only, lowest to highest:
 *   1. the pack's `models:` block in ~/.wolfpack/config.yaml
 *   2. the wolf's wolf.yaml (`transport:` and a `models:` block)
 * There are no env-var overrides and no defaults in code: a pack config
 * without `models:` is an error (`wolfpack setup` / `wolfpack config` write it).
 *
 * `resolveModelTable` is pure. `loadModelTable` is the one loader every
 * runtime calls: it reads a table handed over by `wolfpack launch` / shipped
 * in a bundle (WOLFPACK_MODELS_FILE), else resolves from the config files.
 *
 *   # ~/.wolfpack/config.yaml
 *   models:
 *     main:  { model: claude-opus-5-5 }
 *     smart: { model: claude-sonnet-5-5 }
 *     fast:  { model: claude-haiku-5-5 }
 *     transport: { local: subscription, vps: api }
 *
 *   # wolf.yaml (all optional)
 *   transport: subscription
 *   models:
 *     fast: { model: claude-sonnet-5-5, thinking: low }
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

export const TIERS = ["main", "smart", "fast"] as const;
export type Tier = (typeof TIERS)[number];

/** Every engine step the repo calls. Adding one here forces a tier below. */
export const ENGINE_STEPS = [
  "classify",
  "consolidate",
  "produce",
  "contradict",
  "classifyToSection",
  "matchSubject",
  "sectionSummary",
  "labelSection",
] as const;
export type EngineStep = (typeof ENGINE_STEPS)[number];

/** Fixed use → tier map. Wolves can't remap a step to another tier. */
export const STEP_TIERS: Record<EngineStep, Tier> = {
  classify: "fast",
  consolidate: "smart",
  produce: "smart",
  contradict: "fast",
  classifyToSection: "fast",
  matchSubject: "fast",
  sectionSummary: "fast",
  labelSection: "fast",
};

/** pi's thinking levels (`pi --help`), used everywhere thinking is set. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Provider effort level for a thinking level (`minimal` has no effort equivalent → `low`). */
export function effortFor(level: Exclude<ThinkingLevel, "off">): "low" | "medium" | "high" | "xhigh" | "max" {
  return level === "minimal" ? "low" : level;
}

export const TRANSPORTS = ["subscription", "api"] as const;
export type Transport = (typeof TRANSPORTS)[number];

export type WolfLocation = "local" | "vps";

/**
 * Model IDs known on 2026-10-20 (Anthropic `GET /v1/models`; the bridge lists
 * the same undated IDs). Used only to warn about likely typos — an unknown ID
 * still resolves, so a brand-new model works before this list is updated.
 */
export const KNOWN_MODELS: readonly string[] = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-fable-5-1",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-opus-4-5",
  "claude-opus-4-5-20251101",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
];

/**
 * The `models:` block `wolfpack setup` writes into a new pack config. Not a
 * runtime fallback — the resolver never reads this; it only seeds config.
 */
export const STARTER_PACK_MODELS = {
  main: { model: "claude-opus-5-5" },
  smart: { model: "claude-sonnet-5-5" },
  fast: { model: "claude-haiku-5-5" },
  transport: { local: "subscription", vps: "api" },
} as const satisfies PackModels;

/** Engine provider and pi provider per transport. The model ID is identical. */
const TRANSPORT_PROVIDERS: Record<Transport, { engine: string; pi: string }> = {
  subscription: { engine: "claude-agent-sdk", pi: "claude-bridge" },
  api: { engine: "anthropic", pi: "anthropic" },
};

export interface TierSetting {
  model?: string;
  thinking?: string;
}

/** The pack's `models:` block (~/.wolfpack/config.yaml). */
export interface PackModels {
  main?: TierSetting;
  smart?: TierSetting;
  fast?: TierSetting;
  transport?: { local?: string; vps?: string };
}

/** The model-related keys of a wolf.yaml. */
export interface WolfModels {
  transport?: string;
  models?: { main?: TierSetting; smart?: TierSetting; fast?: TierSetting };
}

export type ModelSource = "pack" | "wolf";

export interface ResolvedTier {
  model: string;
  modelSource: ModelSource;
  thinking?: ThinkingLevel;
  thinkingSource?: ModelSource;
  /** Engine provider (`createEngine({ provider })`). */
  provider: string;
  /** pi model string: `<pi provider>/<id>`, without the thinking suffix. */
  piModel: string;
}

export interface ModelTable {
  location: WolfLocation;
  transport: Transport;
  transportSource: ModelSource;
  tiers: Record<Tier, ResolvedTier>;
  steps: Record<EngineStep, { tier: Tier }>;
  warnings: string[];
}

export interface ResolveInput {
  pack: PackModels | undefined;
  wolf?: WolfModels;
  location: WolfLocation;
}

const FIX_HINT = "run `wolfpack config` → Models (or `wolfpack setup`) to write the pack's models: block";

export class ModelConfigError extends Error {
  constructor(message: string) {
    super(`${message} — ${FIX_HINT}`);
    this.name = "ModelConfigError";
  }
}

export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function isTransport(value: unknown): value is Transport {
  return typeof value === "string" && (TRANSPORTS as readonly string[]).includes(value);
}

/** Resolve the wolf's model table. Pure; throws ModelConfigError on missing pack config. */
export function resolveModelTable(input: ResolveInput): ModelTable {
  const { pack, wolf, location } = input;
  const warnings: string[] = [];
  if (!pack) throw new ModelConfigError("No models: block in the pack config");

  // Transport: wolf.yaml > pack default for the wolf's location.
  const packTransport = pack.transport?.[location];
  if (!isTransport(packTransport)) {
    throw new ModelConfigError(
      `Pack models.transport.${location} must be one of ${TRANSPORTS.join("|")} (got ${JSON.stringify(packTransport)})`,
    );
  }
  let transport: Transport = packTransport;
  let transportSource: ModelSource = "pack";
  if (wolf?.transport !== undefined) {
    if (isTransport(wolf.transport)) {
      transport = wolf.transport;
      transportSource = "wolf";
    } else {
      warnings.push(
        `wolf.yaml transport "${wolf.transport}" is not ${TRANSPORTS.join("|")}; using the pack default (${packTransport})`,
      );
    }
  }
  const providers = TRANSPORT_PROVIDERS[transport];

  const tiers = {} as Record<Tier, ResolvedTier>;
  for (const tier of TIERS) {
    const packTier = pack[tier];
    const wolfTier = wolf?.models?.[tier];

    const packModel = nonEmpty(packTier?.model);
    if (!packModel) throw new ModelConfigError(`Pack models.${tier}.model is not set`);
    const wolfModel = nonEmpty(wolfTier?.model);
    const model = wolfModel ?? packModel;
    const modelSource: ModelSource = wolfModel ? "wolf" : "pack";
    if (!KNOWN_MODELS.includes(model)) {
      warnings.push(`${tier}: unknown model "${model}" (${modelSource}) — check for a typo`);
    }

    const resolved: ResolvedTier = {
      model,
      modelSource,
      provider: providers.engine,
      piModel: `${providers.pi}/${model}`,
    };

    // Thinking: wolf > pack, each value checked against pi's levels.
    for (const [source, raw] of [["wolf", wolfTier?.thinking], ["pack", packTier?.thinking]] as const) {
      const value = nonEmpty(raw);
      if (value === undefined) continue;
      if (!isThinkingLevel(value)) {
        warnings.push(`${tier}: unknown thinking level "${value}" (${source}); ignored — use ${THINKING_LEVELS.join("|")}`);
        continue;
      }
      resolved.thinking = value;
      resolved.thinkingSource = source;
      break;
    }
    tiers[tier] = resolved;
  }

  const steps = {} as Record<EngineStep, { tier: Tier }>;
  for (const step of ENGINE_STEPS) steps[step] = { tier: STEP_TIERS[step] };

  return { location, transport, transportSource, tiers, steps, warnings };
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** pi `--model` value for a tier: `<provider>/<id>[:<thinking>]`. */
export function piModelArg(tier: ResolvedTier): string {
  return tier.thinking ? `${tier.piModel}:${tier.thinking}` : tier.piModel;
}

/**
 * Per-step model config for `createEngine({ steps })`, from the table. Call
 * sites only layer non-model knobs (e.g. maxTokens) on top.
 */
export function engineSteps(table: ModelTable): Record<EngineStep, { model: string; thinking?: ThinkingLevel }> {
  const out = {} as Record<EngineStep, { model: string; thinking?: ThinkingLevel }>;
  for (const step of ENGINE_STEPS) {
    const t = table.tiers[table.steps[step].tier];
    out[step] = t.thinking ? { model: t.model, thinking: t.thinking } : { model: t.model };
  }
  return out;
}

/** Canonical JSON of the table (sorted keys, no warnings) — the drift-hash input. */
export function modelTableFingerprint(table: ModelTable): string {
  const { warnings: _warnings, ...rest } = table;
  return canonicalJson(rest);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// ── Loader ───────────────────────────────────────────────────────────────────

/** Env var naming a resolved-table file (set by `wolfpack launch`, or the harness). A pointer, not config. */
export const MODELS_FILE_ENV = "WOLFPACK_MODELS_FILE";

/** The pack config file: ~/.wolfpack/config.yaml. */
export function packConfigPath(home: string = os.homedir()): string {
  return path.join(home, ".wolfpack", "config.yaml");
}

/** Read the `models:` block of a pack config file (undefined if absent or unreadable). */
export function readPackModels(file: string = packConfigPath()): PackModels | undefined {
  const parsed = readYaml(file) as { models?: PackModels } | undefined;
  return parsed?.models ?? undefined;
}

/** Read the model keys (`transport`, `models`) of a wolf.yaml. */
export function readWolfModels(file: string): WolfModels | undefined {
  const parsed = readYaml(file) as WolfModels | undefined;
  if (!parsed) return undefined;
  return { transport: parsed.transport, models: parsed.models };
}

function readYaml(file: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  return parseYaml(raw) ?? undefined;
}

export function writeModelTable(file: string, table: ModelTable): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(table, null, 2) + "\n");
}

export function readModelTable(file: string): ModelTable {
  const table = JSON.parse(fs.readFileSync(file, "utf8")) as ModelTable;
  if (!table?.tiers || !table.steps || !table.transport) {
    throw new Error(`${file} is not a resolved model table`);
  }
  return table;
}

export interface LoadModelTableOptions {
  /** Explicit table file (wins over the env var). */
  file?: string;
  /** Environment to read WOLFPACK_MODELS_FILE / WOLF_DEN from (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** Pack config file (default ~/.wolfpack/config.yaml). */
  packConfigFile?: string;
  /** wolf.yaml to layer on (default $WOLF_DEN/../wolf.yaml when WOLF_DEN is set). */
  wolfYaml?: string;
  /** Location used when resolving from config (default local). */
  location?: WolfLocation;
}

/**
 * The one loader both runtimes call. Prefers a handed-over table: an explicit
 * file or WOLFPACK_MODELS_FILE, else the models.json beside the wolf's
 * wolf.yaml (written by launch, shipped by sync — so a VPS CLI run with only
 * WOLF_DEN set finds it). Otherwise resolves from the pack config and the
 * wolf's wolf.yaml. `fromLaunch` is false for that fallback so a pi session
 * can flag it.
 */
export function loadModelTable(opts: LoadModelTableOptions = {}): { table: ModelTable; fromLaunch: boolean } {
  const env = opts.env ?? process.env;
  const file = opts.file ?? env[MODELS_FILE_ENV];
  if (file) return { table: readModelTable(file), fromLaunch: true };

  const wolfHome = env.WOLF_DEN ? path.join(env.WOLF_DEN, "..") : undefined;
  const besideWolf = wolfHome ? path.join(wolfHome, "models.json") : undefined;
  if (besideWolf && fs.existsSync(besideWolf)) return { table: readModelTable(besideWolf), fromLaunch: true };

  const wolfYaml = opts.wolfYaml ?? (wolfHome ? path.join(wolfHome, "wolf.yaml") : undefined);
  const table = resolveModelTable({
    pack: readPackModels(opts.packConfigFile ?? packConfigPath()),
    wolf: wolfYaml ? readWolfModels(wolfYaml) : undefined,
    location: opts.location ?? "local",
  });
  return { table, fromLaunch: false };
}
