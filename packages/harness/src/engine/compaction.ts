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

export interface CompactionConfig {
  /** Absolute context size (tokens) at which the background summary starts. */
  startAt?: number;
  reserveTokens?: number;
  keepRecentTokens?: number;
  enabled?: boolean;
}

/** pi-durable's defaults (DEFAULT_COMPACTION_POLICY); mirrored here for the derivation and the thresholds. */
export const DEFAULT_RESERVE_TOKENS = 16384;
export const DEFAULT_BACKGROUND_TOKENS = 32768;

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
  if (cfg.startAt !== undefined) {
    const reserve = cfg.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
    const overrides: Record<string, { backgroundTokens: number }> = {};
    for (const m of models.getModels()) {
      if (typeof m.contextWindow === "number" && m.contextWindow > 0) overrides[`${m.provider}/${m.id}`] = { backgroundTokens: backgroundTokensFor(m.contextWindow, reserve, cfg.startAt) };
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
export function thresholds(window: number, cfg: CompactionConfig | undefined): { startAt: number; waitAt: number } {
  const reserve = cfg?.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
  const background = cfg?.startAt !== undefined ? backgroundTokensFor(window, reserve, cfg.startAt) : DEFAULT_BACKGROUND_TOKENS;
  return { startAt: Math.max(0, window - reserve - background), waitAt: Math.max(0, window - reserve) };
}

/** Rough token estimate for messages (chars / 4). */
export function estimateTokens(messages: readonly Message[]): number {
  let chars = 0;
  for (const m of messages) chars += JSON.stringify((m as { content?: unknown }).content ?? "").length;
  return Math.ceil(chars / 4);
}

/** Context size from the model context: the newest assistant message's usage plus an estimate of the messages after it. */
export function contextTokens(messages: readonly Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; usage?: { totalTokens?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number }; stopReason?: string };
    if (m.role !== "assistant" || !m.usage || m.stopReason === "aborted" || m.stopReason === "error") continue;
    const u = m.usage;
    const total = u.totalTokens || (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
    if (total > 0) return total + estimateTokens(messages.slice(i + 1));
  }
  return estimateTokens(messages);
}
