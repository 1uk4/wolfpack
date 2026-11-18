import { isTier, readModelTable, tierPiProvider, type ModelTable, type Tier, type ThinkingLevel, isThinkingLevel } from "../models.js";
import type { WolfConfig } from "./schema.js";

export class TierResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TierResolutionError";
  }
}

export interface ResolvedWolfModel {
  /** Tier that was asked for. */
  requestedTier: string;
  /** Tier actually used (main when the requested tier is absent from the table). */
  tier: Tier;
  fellBack: boolean;
  modelId: string;
  thinking?: ThinkingLevel;
  transport: "api" | "subscription";
  /** pi provider id of the tier (e.g. "anthropic", "claude-stateless"). */
  provider: string;
  piModel: string;
  /** True when wolf.yaml `tiers:` overrode the models file's model. */
  overridden: boolean;
}

/**
 * Resolve a tier for a wolf: models file (path or parsed table) + the wolf's
 * `tiers:` overrides. Both transports resolve (subscription → the claude-stateless
 * provider); a tier missing from the table falls back to `main`.
 */
export function resolveWolfModel(
  config: Pick<WolfConfig, "capability">,
  tier: string,
  modelsFile: string | ModelTable,
): ResolvedWolfModel {
  if (!isTier(tier)) {
    throw new TierResolutionError(`Unknown tier "${tier}" — use main|smart|fast`);
  }
  const table = typeof modelsFile === "string" ? readModelTable(modelsFile) : modelsFile;

  if (table.transport !== undefined && table.transport !== "api" && table.transport !== "subscription") {
    throw new TierResolutionError(
      `Models file has unknown transport "${String(table.transport)}" — expected api|subscription`,
    );
  }

  let used: Tier = tier;
  let entry = table.tiers[tier];
  if (!entry?.model) {
    if (tier === "main" || !table.tiers.main?.model) {
      throw new TierResolutionError(`Models file has no model for tier "${tier}" (and no main to fall back to)`);
    }
    used = "main";
    entry = table.tiers.main;
  }

  const override = config.capability.tiers?.[used];
  const modelId = override?.model ?? entry.model;
  const thinkingRaw = override?.thinking ?? entry.thinking;
  const thinking = isThinkingLevel(thinkingRaw) ? thinkingRaw : undefined;
  // The pi provider is per tier (piProvider / the piModel prefix); legacy tables fall back to the transport's.
  const provider = tierPiProvider(table, entry);

  return {
    requestedTier: tier,
    tier: used,
    fellBack: used !== tier,
    modelId,
    ...(thinking ? { thinking } : {}),
    transport: table.transport,
    provider,
    piModel: override?.model ? `${provider}/${modelId}` : entry.piModel,
    overridden: override?.model !== undefined,
  };
}

/**
 * The model table as THIS wolf sees it: wolf.yaml `tiers:` overrides applied to every tier the table has, with the
 * same precedence as resolveWolfModel (override > models file). Engine steps (memory classify/consolidate/distill/...)
 * read their model from `table.tiers[STEP_TIERS[step]]`, so applying the overrides here makes them honour wolf.yaml.
 * Pure: returns a new table.
 */
export function applyWolfTierOverrides(table: ModelTable, config: Pick<WolfConfig, "capability">): ModelTable {
  const overrides = config.capability.tiers;
  if (!overrides) return table;
  const tiers = { ...table.tiers };
  for (const name of Object.keys(tiers) as Tier[]) {
    const o = overrides[name];
    const t = tiers[name];
    if (!o || !t) continue;
    const model = o.model ?? t.model;
    const thinking = isThinkingLevel(o.thinking) ? o.thinking : t.thinking;
    const slash = t.piModel.indexOf("/");
    tiers[name] = {
      ...t,
      model,
      piModel: o.model && slash >= 0 ? `${t.piModel.slice(0, slash)}/${model}` : t.piModel,
      ...(thinking ? { thinking } : {}),
    };
  }
  return { ...table, tiers };
}

/** pi providers that serve Anthropic models (API key, or the Claude subscription): the only ones memory.model may name a model of. */
const ANTHROPIC_PI = new Set(["anthropic", "claude-stateless"]);

/**
 * The table the wolf's MEMORY engine steps read: wolf.yaml `memory.model` replaces the model of the SMART tier only (the memory's main
 * steps: consolidate, distill, workRecord...). The fast tier keeps its cheap model, so the quick steps (classify, workLog...) cost the
 * same; the main tier, which is the chat, is untouched. A smart tier on a non-Anthropic provider is left as it is and one line is logged
 * (wolf name and model id, never a key). Pure apart from that line: returns a new table; no `memory.model`: the same one.
 */
export function applyWolfMemoryModel(table: ModelTable, config: Pick<WolfConfig, "memory" | "identity">, log: (line: string) => void = console.warn): ModelTable {
  const model = config.memory.model;
  if (!model) return table;
  const t = table.tiers.smart;
  if (!t) return table;
  if (!ANTHROPIC_PI.has(tierPiProvider(table, t))) {
    log(`[memory] ${config.identity.name}: memory.model ${model} ignored: the smart tier is not an Anthropic provider`);
    return table;
  }
  const slash = t.piModel.indexOf("/");
  return { ...table, tiers: { ...table.tiers, smart: { ...t, model, piModel: slash >= 0 ? `${t.piModel.slice(0, slash)}/${model}` : t.piModel } } };
}
