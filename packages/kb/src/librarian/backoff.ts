/**
 * backoff — keep a sweep outage from spamming alerts or parking healthy items.
 *
 * Errors split in two (classifyError): "infra" (the LLM API, the network or
 * Ollama is down — nothing to do with the contribution) and "item" (the
 * contribution itself is the problem). Only item errors count toward an item's
 * maxAttempts. An infra error skips the tick and backs the sweeper off
 * (1m, 2m, 4m, 8m, capped at 15m) until a tick succeeds.
 *
 * The state is one small JSON file in KB_OPS, written atomically, so the
 * launchd/CLI path (a new process every minute) and the harness timer both
 * honour it. Alerts fire on the transitions only: one when the sweep starts
 * failing, one when it recovers.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SWEEP, OutputTruncatedError } from "@wolfpack/engine";
import type { KbRoots } from "../shared/index.js";
import { BudgetExceeded } from "./park.js";

/** A failure of infrastructure the sweep depends on (Ollama, the network). */
export class InfraError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "InfraError";
  }
}

export type ErrorClass = "infra" | "item";

const INFRA_CODES = /^(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH|UND_ERR_\w+)$/;
const INFRA_MESSAGE =
  /overloaded|rate.?limit|too many requests|fetch failed|socket hang up|network|connection (error|refused|reset)|timed? ?out|timeout|service unavailable|bad gateway|gateway timeout|internal server error|unauthori[sz]ed|authentication|forbidden|invalid x-api-key|invalid api key|credit balance|usage limit|hit your (session |weekly |usage )?limit|limit reached|\/login|oauth|\b(429|500|502|503|504|529)\b|\b(401|403)\b/i;

/**
 * The one place errors are classified. Infra: LLM API down/5xx/overloaded/429,
 * network errors, Ollama unreachable/timed out, auth failures. Everything else
 * (bad JSON/schema from the model, validation failures, unknown errors) is the
 * item's own problem.
 */
export function classifyError(err: unknown): ErrorClass {
  if (err instanceof BudgetExceeded) return "item";
  if (err instanceof InfraError) return "infra";
  if (err instanceof OutputTruncatedError) return "item";
  for (let e: unknown = err, depth = 0; e && depth < 4; depth++) {
    const o = e as { errorClass?: unknown; name?: unknown; code?: unknown; status?: unknown; statusCode?: unknown; cause?: unknown };
    if (o.errorClass === "infra" || o.errorClass === "item") return o.errorClass;
    if (o.name === "TimeoutError" || o.name === "APIConnectionError" || o.name === "APIConnectionTimeoutError") return "infra";
    if (typeof o.code === "string" && INFRA_CODES.test(o.code)) return "infra";
    const status = Number(o.status ?? o.statusCode);
    if (status === 401 || status === 403 || status === 408 || status === 429 || status >= 500) return "infra";
    e = o.cause;
  }
  const msg = err instanceof Error ? err.message : String(err);
  // A schema/JSON failure is about the item even if its text mentions a status.
  if (/^Failed to extract valid output/.test(msg)) return "item";
  return INFRA_MESSAGE.test(msg) ? "infra" : "item";
}

/**
 * True when retrying the item cannot help (the model's output was cut off at
 * its cap), so the sweep should park it now instead of counting attempts.
 */
export function shouldParkNow(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 4; depth++) {
    if (e instanceof OutputTruncatedError || (e as { parkNow?: unknown }).parkNow === true) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

// ── persisted backoff state ─────────────────────────────────────────────────

/** Contents of KB_OPS/sweep-backoff.json. Absent file = healthy. */
export interface BackoffState {
  /** Consecutive failed ticks. */
  consecutive: number;
  /** Epoch ms before which ticks are skipped. */
  nextAttemptAt: number;
  /** ISO time the sweep first started failing. */
  since: string;
  /** Short reason of the latest failure. */
  reason: string;
}

export const backoffFile = (roots: KbRoots) => join(roots.opsRoot, "sweep-backoff.json");

export function readBackoff(roots: KbRoots): BackoffState | null {
  try {
    const s = JSON.parse(readFileSync(backoffFile(roots), "utf-8")) as BackoffState;
    return typeof s.nextAttemptAt === "number" && typeof s.consecutive === "number" ? s : null;
  } catch {
    return null;
  }
}

/** Delay after the nth consecutive failure: 1m, 2m, 4m, 8m, then capped (15m). */
export function backoffDelayMs(consecutive: number): number {
  return Math.min(SWEEP.backoffBaseMs * 2 ** Math.max(0, consecutive - 1), SWEEP.backoffMaxMs);
}

/** Milliseconds left before the next tick may run (0 = run now). */
export function backoffRemainingMs(roots: KbRoots, nowMs = Date.now()): number {
  const s = readBackoff(roots);
  return s ? Math.max(0, s.nextAttemptAt - nowMs) : 0;
}

function writeBackoff(roots: KbRoots, s: BackoffState): void {
  mkdirSync(roots.opsRoot, { recursive: true });
  const tmp = `${backoffFile(roots)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, backoffFile(roots));
}

export type Alert = (msg: string) => void | Promise<void>;

async function send(alert: Alert | undefined, msg: string): Promise<void> {
  try {
    await alert?.(msg);
  } catch (e) {
    console.error("sweep: alert failed:", e instanceof Error ? e.message : e);
  }
}

/** Record an infra failure: extend the backoff; alert once when entering it. */
export async function noteInfraFailure(
  roots: KbRoots,
  err: unknown,
  alert?: Alert,
  nowMs = Date.now()
): Promise<BackoffState> {
  const prev = readBackoff(roots);
  const reason = (err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 160);
  const consecutive = (prev?.consecutive ?? 0) + 1;
  const state: BackoffState = {
    consecutive,
    nextAttemptAt: nowMs + backoffDelayMs(consecutive),
    since: prev?.since ?? new Date(nowMs).toISOString(),
    reason,
  };
  writeBackoff(roots, state);
  if (!prev) await send(alert, `sweep paused: ${reason}, retrying with backoff`);
  return state;
}

/** Record a successful tick: clear the backoff; alert once on recovery. */
export async function noteSweepSuccess(roots: KbRoots, alert?: Alert): Promise<boolean> {
  if (!existsSync(backoffFile(roots))) return false;
  rmSync(backoffFile(roots), { force: true });
  await send(alert, "sweep recovered: resuming normal operation");
  return true;
}
