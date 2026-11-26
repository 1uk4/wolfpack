/**
 * Turns wolfd's own wolf events (thread-status, thread-updated, card-pending, card-settled) and read-tool starts into
 * activity events for the hub. Observes only; it never changes what wolfd does and never throws.
 *
 *  - thread-status busy/idle  -> thread-active (heartbeat every ACTIVITY_HEARTBEAT_MS while busy) / thread-idle
 *  - thread-updated boundWorkItem change -> bound / unbound
 *  - thread-updated of a subagent: first sight -> subagent-spawned, state done|failed|stopped -> subagent-finished
 *  - card-pending / card-settled -> needs-you / answered
 *  - kb read -> kb-read (`read` tool on a kb-mirror entry path only; never bash)
 * Write, contribution and ship events are NOT emitted here: the hub derives them from its ledger.
 */
import type { ActivityActor } from "@wolfpack/protocol";
import { KbReadThrottle, kbTargetsOfTool } from "./activity-kb.js";
import { ACTIVITY_HEARTBEAT_MS, ACTIVITY_WOLF_BEAT_MS, type ActivityPublisher } from "./activity-publisher.js";

/** The slice of a thread summary the tap needs. */
export interface TapThread {
  id: string;
  kind: string;
  title: string;
  boundWorkItem?: string;
  parentThreadId?: string;
  state?: string;
  /** Set when the thread was removed (wolfd emits thread-updated with closed:true on removeThread). */
  closed?: boolean;
}

type Ev = { type: string; [k: string]: unknown };

export class ActivityTap {
  private beats = new Map<string, ReturnType<typeof setInterval>>();
  private bound = new Map<string, string | undefined>();
  private seenChild = new Set<string>();
  private finishedChild = new Set<string>();
  private throttle = new KbReadThrottle();

  constructor(
    private readonly pub: Pick<ActivityPublisher, "emit">,
    private readonly lookup: (threadId: string) => TapThread | undefined,
    private readonly heartbeatMs = ACTIVITY_HEARTBEAT_MS,
  ) {}

  private actor(t: TapThread | undefined, threadId: string): ActivityActor {
    if (t?.kind === "subagent") {
      return { kind: "subagent", threadId, subagent: t.title || threadId, ...(t.parentThreadId ? { parentThreadId: t.parentThreadId } : {}), title: t.title };
    }
    return { kind: "thread", threadId, ...(t ? { title: t.title } : {}) };
  }

  private active(threadId: string): void {
    const t = this.lookup(threadId);
    this.pub.emit({
      verb: "thread-active",
      actor: this.actor(t, threadId),
      ...(t?.boundWorkItem ? { target: { kind: "work-item" as const, id: t.boundWorkItem } } : {}),
    });
  }

  /** Feed every wolf event (as emitted by the server, before ids are stamped). */
  onWolfEvent(ev: Ev): void {
    try {
      switch (ev.type) {
        case "thread-status": {
          const id = String(ev.threadId);
          if (ev.status === "busy") {
            if (this.beats.has(id)) return;
            this.throttle.newTurn(id);
            this.active(id);
            const h = setInterval(() => {
              try {
                if (!this.lookup(id)) return this.forget(id); // the thread is gone: no more heartbeats
                this.active(id);
              } catch { /* ignore */ }
            }, this.heartbeatMs);
            h.unref?.();
            this.beats.set(id, h);
          } else {
            const h = this.beats.get(id);
            if (!h) return; // never went active: nothing to end
            clearInterval(h);
            this.beats.delete(id);
            this.pub.emit({ verb: "thread-idle", actor: this.actor(this.lookup(id), id) });
          }
          return;
        }
        case "thread-updated":
          return this.threadUpdated(ev.thread as TapThread);
        case "card-pending": {
          const c = ev.card as { threadId: string };
          this.pub.emit({ verb: "needs-you", actor: this.actor(this.lookup(c.threadId), c.threadId) });
          return;
        }
        case "card-settled": {
          const id = String(ev.threadId);
          this.pub.emit({ verb: "answered", actor: this.actor(this.lookup(id), id) });
          return;
        }
      }
    } catch { /* observation only */ }
  }

  /** Drop everything remembered about a thread (removed or finished) and stop its heartbeat. */
  private forget(id: string): void {
    const h = this.beats.get(id);
    if (h) clearInterval(h);
    this.beats.delete(id);
    this.bound.delete(id);
    this.seenChild.delete(id);
    this.finishedChild.delete(id);
    this.throttle.forget(id);
  }

  private threadUpdated(t: TapThread | undefined): void {
    if (!t?.id) return;
    if (t.closed) return this.forget(t.id);
    // bound / unbound
    const prev = this.bound.has(t.id) ? this.bound.get(t.id) : undefined;
    const seen = this.bound.has(t.id);
    this.bound.set(t.id, t.boundWorkItem);
    if (seen || t.boundWorkItem) {
      if (t.boundWorkItem && t.boundWorkItem !== prev) {
        this.pub.emit({ verb: "bound", actor: this.actor(t, t.id), target: { kind: "work-item", id: t.boundWorkItem } });
      } else if (!t.boundWorkItem && prev) {
        this.pub.emit({ verb: "unbound", actor: this.actor(t, t.id), target: { kind: "work-item", id: prev } });
      }
    }
    // subagents
    if (t.kind === "subagent" && t.parentThreadId) {
      const target = { kind: "thread" as const, id: t.parentThreadId };
      if (!this.seenChild.has(t.id)) {
        this.seenChild.add(t.id);
        if (t.state === "done" || t.state === "failed" || t.state === "stopped") this.finishedChild.add(t.id); // restored finished child: no event
        else this.pub.emit({ verb: "subagent-spawned", actor: this.actor(t, t.id), target });
      } else if ((t.state === "done" || t.state === "failed" || t.state === "stopped") && !this.finishedChild.has(t.id)) {
        this.finishedChild.add(t.id);
        this.pub.emit({ verb: "subagent-finished", actor: this.actor(t, t.id), target });
      } else if (t.state === "running" || t.state === "queued") {
        this.finishedChild.delete(t.id); // resumed: its next finish counts again
      }
    }
  }

  /** A tool started in a thread: KB reads (see activity-kb.ts) become kb-read, throttled per thread. Args are never kept. */
  onToolStart(threadId: string, toolName: string, args: unknown): void {
    try {
      for (const t of kbTargetsOfTool(toolName, args)) {
        if (!this.throttle.allow(threadId, t)) continue;
        this.pub.emit({ verb: "kb-read", actor: this.actor(this.lookup(threadId), threadId), target: t, ...(t.domain ? { domain: t.domain } : {}) });
      }
    } catch { /* ignore */ }
  }

  private wolfBeat: ReturnType<typeof setInterval> | undefined;
  private wolfName: string | undefined;

  /** Announce the wolf now and every ACTIVITY_WOLF_BEAT_MS, idle or busy (unref'd; emit never blocks). */
  startWolfBeat(wolf: string, periodMs = ACTIVITY_WOLF_BEAT_MS): void {
    if (this.wolfBeat) return;
    this.wolfName = wolf;
    const beat = () => this.pub.emit({ verb: "wolf-online", actor: { kind: "wolf", wolf } });
    try { beat(); } catch { /* ignore */ }
    this.wolfBeat = setInterval(() => { try { beat(); } catch { /* ignore */ } }, periodMs);
    this.wolfBeat.unref?.();
  }

  stop(): void {
    for (const h of this.beats.values()) clearInterval(h);
    this.beats.clear();
    if (this.wolfBeat) {
      clearInterval(this.wolfBeat);
      this.wolfBeat = undefined;
      try { this.pub.emit({ verb: "wolf-offline", actor: { kind: "wolf", wolf: this.wolfName! } }); } catch { /* best effort */ }
    }
  }
}
