import { isTier, readModelTable, type ModelTable, type Tier, type ThinkingLevel, isThinkingLevel } from "../models.js";
import type { WolfConfig } from "./schema.js";

/** Task gating the subscription transport. */
export const SUBSCRIPTION_BRIDGE_TASK = "work-wolfpack-p81a6iI";

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
  transport: "api";
  /** Engine/pi provider for the transport. */
  provider: string;
  piModel: string;
  /** True when wolf.yaml `tiers:` overrode the models file's model. */
  overridden: boolean;
}

/**
 * Resolve a tier for a wolf: models file (path or parsed table) + the wolf's
 * `tiers:` overrides. Subscription transport is rejected until the bridge
 * lands; a tier missing from the table falls back to `main`.
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

  if (table.transport === "subscription") {
    throw new TierResolutionError(
      `Models file uses transport "subscription", which the wolf process does not support yet ` +
        `(subscription bridge pending: task ${SUBSCRIPTION_BRIDGE_TASK}). ` +
        `Use transport "api" (set ANTHROPIC_API_KEY) in the models file or pack config.`,
    );
  }
  if (table.transport !== "api") {
    throw new TierResolutionError(`Models file has unknown transport "${String(table.transport)}" — expected api`);
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
  const provider = entry.provider ?? "anthropic";

  return {
    requestedTier: tier,
    tier: used,
    fellBack: used !== tier,
    modelId,
    ...(thinking ? { thinking } : {}),
    transport: "api",
    provider,
    piModel: override?.model ? `anthropic/${modelId}` : entry.piModel,
    overridden: override?.model !== undefined,
  };
}
