/**
 * One pi assistant message (as pi session files and pi-durable stores both
 * record it) → one UsageEvent.
 */
import { billingFor, type UsageEvent, type UsageSource } from "@wolfpack/engine";
import { priceEvent } from "./pricing.js";

/** The fields of a pi AssistantMessage this reads. */
export interface PiAssistantMessage {
  role?: string;
  provider?: string;
  model?: string;
  responseModel?: string;
  timestamp?: number;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cacheWrite1h?: number;
    cost?: { total?: number };
  };
}

export interface MessageContext {
  /** The event's stable ledger id. */
  id?: string;
  wolf: string;
  source: UsageSource;
  session?: string;
  use: string;
  /** Fallback when the message has no timestamp of its own. */
  ts?: string;
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The event for an assistant message with usage, else undefined. */
export function eventFromMessage(m: PiAssistantMessage, ctx: MessageContext): UsageEvent | undefined {
  if (m.role !== "assistant" || !m.usage) return undefined;
  const ts = typeof m.timestamp === "number" ? new Date(m.timestamp).toISOString() : ctx.ts;
  if (!ts) return undefined;
  const provider = m.provider ?? "unknown";
  const u = m.usage;
  return priceEvent(
    {
      ...(ctx.id ? { id: ctx.id } : {}),
      ts,
      wolf: ctx.wolf,
      source: ctx.source,
      session: ctx.session,
      use: ctx.use,
      provider,
      billing: billingFor(provider),
      model: m.model ?? "unknown",
      input: n(u.input),
      output: n(u.output),
      cacheRead: n(u.cacheRead),
      cacheWrite: n(u.cacheWrite),
    },
    u.cost?.total,
    u.cacheWrite1h,
  );
}
