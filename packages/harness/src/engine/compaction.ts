/**
 * Compaction policy + context statistics, the engine-side half of the thread context chip.
 *
 * Policy: wolf.yaml `compaction: {startAt, reserveTokens?, keepRecentTokens?, enabled?}` becomes pi-durable
 * `HarnessSettings.compaction`. pi-durable's background threshold is relative (`backgroundTokens` below
 * `contextWindow - reserveTokens`), while `startAt` is absolute, so it is mapped per model through
 * `modelOverrides["provider/modelId"]`: backgroundTokens = max(default, window - reserve - startAt).
 */
import type { Models } from "@earendil-works/pi-ai/models";
import type { Message } from "@earendil-works/pi-ai";
import { DEFAULT_COMPACTION_POLICY } from "@earendil-works/pi-durable";
import { calculateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";

export interface CompactionConfig {
  /** Absolute context size (tokens) at which the background summary starts. */
  startAt?: number;
  reserveTokens?: number;
  keepRecentTokens?: number;
  enabled?: boolean;
}

/** pi-durable's defaults, used for the derivation and the thresholds. */
export const DEFAULT_RESERVE_TOKENS = DEFAULT_COMPACTION_POLICY.reserveTokens;
export const DEFAULT_BACKGROUND_TOKENS = DEFAULT_COMPACTION_POLICY.backgroundTokens;

export interface CompactionSettingsOut {
  enabled?: boolean;
  reserveTokens?: number;
  keepRecentTokens?: number;
  modelOverrides?: Record<string, { backgroundTokens: number }>;
}

export function backgroundTokensFor(window: number, reserve: number, startAt: number): number {
  return Math.max(DEFAULT_BACKGROUND_TOKENS, window - reserve - startAt);
}

/** Undefined when nothing is configured (pi-durable defaults then apply unchanged). */
export function compactionSettings(models: Models, cfg: CompactionConfig | undefined): CompactionSettingsOut | undefined {
  if (!cfg || Object.keys(cfg).length === 0) return undefined;
  const out: CompactionSettingsOut = {
    ...(cfg.enabled !== undefined ? { enabled: cfg.enabled } : {}),
    ...(cfg.reserveTokens !== undefined ? { reserveTokens: cfg.reserveTokens } : {}),
    ...(cfg.keepRecentTokens !== undefined ? { keepRecentTokens: cfg.keepRecentTokens } : {}),
  };
  if (cfg.startAt !== undefined && cfg.enabled !== false) {
    const reserve = cfg.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
    const overrides: Record<string, { backgroundTokens: number }> = {};
    for (const m of models.getModels()) {
      if (typeof m.contextWindow !== "number" || m.contextWindow <= 0) console.warn(`[compaction] ${m.provider}/${m.id}: no context window, no startAt override`);
      else overrides[`${m.provider}/${m.id}`] = { backgroundTokens: backgroundTokensFor(m.contextWindow, reserve, cfg.startAt) };
    }
    if (Object.keys(overrides).length) out.modelOverrides = overrides;
  }
  return out;
}

export interface EngineContextStats {
  /** Current context size: last assistant usage + estimate of what came after (or an estimate of all of it). */
  tokens: number;
  /** Model context window; absent when the model is unknown to the registry. */
  window?: number;
  /** Background summary starts past this (effective, absolute); a generation waits for a compaction past `waitAt`. */
  startAt?: number;
  waitAt?: number;
  compactions: { count: number; lastAt?: number };
}

/** The effective thresholds for a model window under `cfg`. */
export function thresholds(window: number, cfg: CompactionConfig | undefined): { startAt?: number; waitAt?: number } {
  if (cfg?.enabled === false) return {};
  const reserve = cfg?.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
  const background = cfg?.startAt !== undefined ? backgroundTokensFor(window, reserve, cfg.startAt) : DEFAULT_BACKGROUND_TOKENS;
  return { startAt: Math.max(0, window - reserve - background), waitAt: Math.max(0, window - reserve) };
}

/**
 * Context size of a view, mirroring pi-durable's `estimateContext` (not exported): trust the usage of the newest
 * assistant message appended AFTER the head marker (its request included the compaction summary); an assistant message
 * kept in the tail from before the compaction still reports the old, huge context and is ignored. Messages after the
 * measured one (or all of them when none qualifies) are estimated.
 */
export function contextTokens(view: {
  head: { id: number } | undefined;
  entries: readonly { id: number }[];
  contributions: readonly (readonly Message[])[];
  messages: readonly Message[];
}): number {
  const after = view.head?.id ?? Number.NEGATIVE_INFINITY;
  let measured: Message | undefined;
  for (let i = view.entries.length - 1; i >= 0 && measured === undefined; i--) {
    if (view.entries[i]!.id <= after) continue;
    const msgs = view.contributions[i]!;
    for (let j = msgs.length - 1; j >= 0 && measured === undefined; j--) {
      const m = msgs[j]!;
      if (m.role === "assistant" && calculateContextTokens(m.usage) > 0) measured = m;
    }
  }
  const from = measured === undefined ? 0 : view.messages.lastIndexOf(measured) + 1;
  let tokens = measured?.role === "assistant" ? calculateContextTokens(measured.usage) : 0;
  for (const m of view.messages.slice(from)) tokens += estimateMessageTokens(m);
  return tokens;
}
