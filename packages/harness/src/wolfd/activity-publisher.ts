/**
 * Publishes activity events (live pack map) to the hub: `POST {hubUrl}/v1/activity` with `{v:1, events}`.
 *
 * Fire and forget. `emit` is sync and O(1); nothing in turn code awaits this; every failure is swallowed (a hub that is
 * down, slow, old or unreachable never touches a turn). Bounded queue (oldest dropped), batching, exponential backoff with
 * jitter, a circuit breaker, and a long back-off on 404 (an older hub without the endpoint). Timers are unref'd.
 *
 * PRIVACY: only who/what/which. Titles go through sanitizeActivityTitle. Never pass content or tool arguments.
 */
import { randomUUID } from "node:crypto";
import { ACTIVITY_BATCH_MAX, ACTIVITY_TTL_MAX_MS, sanitizeActivityTitle, type ActivityActor, type ActivityDetail, type ActivityEvent, type ActivityTarget, type ActivityVerb } from "@wolfpack/protocol";
import type { HubEventsTarget } from "./hub-approvals.js";

/** Default time-to-live per verb (ms). thread-active is refreshed by a heartbeat while the thread is busy. */
export const ACTIVITY_DEFAULT_TTL_MS: Record<string, number> = {
  "thread-active": 90_000,
  "thread-idle": 60_000,
  bound: 60 * 60_000,
  unbound: 60_000,
  "subagent-spawned": 60 * 60_000,
  "subagent-finished": 60_000,
  "kb-read": 5 * 60_000,
  "wolf-online": 180_000, // 3x the 60 s wolf heartbeat
  "needs-you": 60 * 60_000,
  answered: 60_000,
};
const FALLBACK_TTL_MS = 60_000;
/** thread-active heartbeat period while a thread is busy. */
export const ACTIVITY_HEARTBEAT_MS = 30_000;
/** wolf-online heartbeat period (idle or busy). */
export const ACTIVITY_WOLF_BEAT_MS = 60_000;

export type ActivityDraft = {
  verb: ActivityVerb;
  actor: ActivityActor;
  target?: ActivityTarget;
  domain?: string;
  ttlMs?: number;
  detail?: ActivityDetail;
};

export interface ActivityPublisherOptions {
  /** Hub to publish to. Unset: every call is a no-op. */
  target: HubEventsTarget | undefined;
  /** This wolf's name (default actor.wolf). */
  wolf: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  queueMax?: number; // 500
  flushMs?: number; // 1000
  flushAt?: number; // 50
  timeoutMs?: number; // 3000
  /** Consecutive failures that open the breaker, and how long it stays open. */
  breakerAfter?: number; // 5
  breakerCooldownMs?: number; // 60000
  notSupportedBackoffMs?: number; // 10 min
  random?: () => number;
}

export class ActivityPublisher {
  private queue: ActivityEvent[] = [];
  private dropped = 0;
  private fails = 0;
  private blockedUntil = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inflight = false;
  private stopped = false;
  private loggedUnsupported = false;
  private loggedFail = false;
  private readonly o: Required<Omit<ActivityPublisherOptions, "target" | "wolf" | "log" | "fetchImpl">> & Pick<ActivityPublisherOptions, "target" | "wolf" | "log" | "fetchImpl">;

  constructor(opts: ActivityPublisherOptions) {
    this.o = {
      queueMax: 500, flushMs: 1000, flushAt: 50, timeoutMs: 3000, breakerAfter: 5, breakerCooldownMs: 60_000,
      notSupportedBackoffMs: 10 * 60_000, random: Math.random, ...opts,
    };
  }

  get droppedCount(): number { return this.dropped; }
  get queued(): number { return this.queue.length; }

  /** Queue an event. Sync, never throws. */
  emit(d: ActivityDraft): void {
    try {
      if (!this.o.target || this.stopped) return;
      const ev: ActivityEvent = {
        v: 1,
        id: randomUUID(),
        pack: "", // the hub fills in the pack from the token
        ts: Date.now(),
        ttlMs: Math.min(d.ttlMs ?? ACTIVITY_DEFAULT_TTL_MS[d.verb] ?? FALLBACK_TTL_MS, ACTIVITY_TTL_MAX_MS),
        actor: { wolf: this.o.wolf, ...d.actor, ...(d.actor.title !== undefined ? { title: sanitizeActivityTitle(d.actor.title) } : {}) },
        verb: d.verb,
        ...(d.target ? { target: { ...d.target, ...(d.target.title !== undefined ? { title: sanitizeActivityTitle(d.target.title) } : {}) } } : {}),
        ...(d.domain ? { domain: d.domain } : {}),
        ...(d.detail ? { detail: d.detail } : {}),
      };
      if (this.queue.length >= this.o.queueMax) {
        this.queue.shift();
        this.dropped++;
      }
      this.queue.push(ev);
      this.schedule(this.queue.length >= this.o.flushAt ? 0 : this.o.flushMs);
    } catch { /* never fail a caller */ }
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) {
      if (ms > 0) return;
      clearTimeout(this.timer);
    }
    const wait = Math.max(ms, this.blockedUntil - Date.now());
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, wait);
    this.timer.unref?.();
  }

  /** Send queued events now (batches of up to 100). Never rejects. */
  async flush(timeoutMs = this.o.timeoutMs): Promise<void> {
    try {
      if (this.inflight || !this.o.target || this.queue.length === 0) return;
      if (Date.now() < this.blockedUntil) return this.schedule(this.blockedUntil - Date.now());
      this.inflight = true;
      const batch = this.queue.splice(0, ACTIVITY_BATCH_MAX);
      let ok = false;
      let status = 0;
      try {
        const res = await (this.o.fetchImpl ?? fetch)(`${this.o.target.url.replace(/\/$/, "")}/v1/activity`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.o.target.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ v: 1, events: batch }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        status = res.status;
        ok = res.ok;
        void res.body?.cancel().catch(() => {});
      } catch (e) {
        if (!this.loggedFail) { this.loggedFail = true; this.o.log?.(`activity publish: ${e instanceof Error ? e.message.slice(0, 120) : "failed"}`); }
      }
      this.inflight = false;
      if (ok) {
        this.fails = 0;
        this.loggedFail = false;
      } else if (status === 404 || status === 401 || status === 403) {
        // 404: an older hub without the endpoint. 401/403: this token may not publish. Either way retrying every few seconds is noise.
        const why = status === 404 ? "hub does not support /v1/activity" : `hub refused the activity token (${status})`;
        this.queue = [];
        this.blockedUntil = Date.now() + this.o.notSupportedBackoffMs;
        if (!this.loggedUnsupported) { this.loggedUnsupported = true; this.o.log?.(`activity publish: ${why}; pausing 10 min`); }
      } else {
        // the batch is lost (activity is ephemeral); back off, and open the breaker after repeated failures
        this.fails++;
        const backoff = this.fails >= this.o.breakerAfter
          ? this.o.breakerCooldownMs
          : Math.min(1000 * 2 ** this.fails, 30_000) * (0.5 + this.o.random() / 2);
        this.blockedUntil = Date.now() + backoff;
      }
      if (this.queue.length > 0) this.schedule(this.queue.length >= this.o.flushAt ? 0 : this.o.flushMs);
    } catch { this.inflight = false; }
  }

  /** Best-effort final flush with a short timeout; later emits are ignored. */
  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.blockedUntil = 0;
    try { await this.flush(500); } catch { /* ignore */ }
    this.stopped = true;
  }
}

/** `<anything>/kb-mirror/domains/<domain>/entries/<id>.md` -> {domain, id}; INDEX.md, _digest.json and other paths: undefined. */
export function kbEntryOfPath(p: string): { domain: string; id: string } | undefined {
  const m = /(?:^|[\\/])kb-mirror[\\/]domains[\\/]([^\\/]+)[\\/]entries[\\/]([^\\/]+)\.md$/.exec(p);
  return m ? { domain: m[1]!, id: m[2]! } : undefined;
}
