/**
 * ThreadRuntime: everything wolfd holds for ONE thread: its engine conversation, the single watcher on it, the pump
 * that maps engine batches to protocol events, the running slot, the per-turn replay buffer, SSE subscribers, the
 * message list, the card tracker and the derived status. A WolfServer owns one per thread (home, feature threads) and
 * routes look the thread up; nothing here is shared between threads, so turns on different threads run concurrently
 * and `busy` is per thread. Wolf-wide concerns (the activity stream, memory routes, listeners) stay in the server and
 * reach it through `ThreadHost`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  pageRange,
  SSE_DONE,
  type Actor,
  type AttachmentRef,
  type CardAnswers,
  type CardClosed,
  type InFlightPartial,
  type SubmitAck,
  DEFAULT_THREAD_SETTINGS,
  type ThreadSettings,
  type ThreadTier,
  type ThreadContext,
  type ThreadDetail,
  type ThreadEvent,
  type ThreadMessage,
  type ThreadStatus,
  type ThreadSummary,
  type WolfEvent,
} from "@wolfpack/protocol";
import {
  EngineBusyError,
  createEventMapper,
  stampEvent,
  type EngineConversation,
  type EngineEvent,
  type EngineSnapshot,
  type EngineWatch,
  type EventMapper,
  type MappedEvent,
  type ResyncDraft,
  type SubmitOptions,
  type ThreadEventDraft,
} from "../engine/index.js";
import { applyEntry, messagesFromEntries } from "./messages.js";
import { AttachmentError, attachmentsInText, inlineAttachments, recordSubmission } from "./attachments.js";
import type { PendingNotice } from "./task-notice.js";
import { withTaskNotice } from "./task-notice.js";
import { CardTracker, answerText, dropHiddenAnswers, supersededNotes, validateAnswers } from "./cards.js";
import { HttpError } from "./http-error.js";
import { readBindingFile } from "@wolfpack/memory";

export type WolfEventDraft = WolfEvent extends infer E ? (E extends unknown ? Omit<E, "id" | "wolf" | "at"> : never) : never;

/** What a thread needs from the wolf-wide server around it. */
export interface ThreadHost {
  readonly name: string;
  readonly den: string | undefined;
  readonly settleMs: number;
  closing(): boolean;
  emitWolf(draft: WolfEventDraft): void;
  onError(error: unknown): void;
  /** Switch a conversation to a model tier (engine configure). Unset: tiers are not switchable on this wolf. */
  applyTier?(conv: EngineConversation, tier: ThreadTier): Promise<void>;
  /** The task-update notice due for a conversation (bound item changed since the last one). Unset: no notices. */
  taskNotice?(conversationId: string): Promise<PendingNotice>;
  /** How long a submit waits for the notice before sending without it. Default 1500. */
  taskNoticeDeadlineMs?: number;
  /**
   * Stall watchdog: a running turn with no engine event for this long (ms) while no tool is executing is reported
   * (an `error` thread event) and aborted. Default 120000; 0 disables.
   */
  stallTimeoutMs?: number;
}

/**
 * Default silence (ms) before a running turn counts as stalled. Deliberately above the bridge's own 90 s idle timeout:
 * the bridge kills a silent round (including a long non-streamed fallback) at 90 s and pi-durable retries it, so this
 * watchdog only needs to fire when the bridge itself is wedged. The retry's events (model-error record, new
 * generation / run start) are engine events and count as activity, so an error + retry at ~90 s does not trip it.
 */
export const DEFAULT_STALL_TIMEOUT_MS = 120_000;

const OPERATOR: Actor = { id: "operator", kind: "operator" };
const SYSTEM: Actor = { id: "wolfd", kind: "system" };

type Sub = (ev: ThreadEvent) => void;

export class ThreadRuntime {
  readonly cards: CardTracker;
  private seq = 0;
  private buffer: ThreadEvent[] = [];
  private running: { turnId: string } | null = null;
  private turnStarts = 0;
  private messages: ThreadMessage[] = [];
  private queuedInputs = new Set<number>();
  /** Owner steers/follow-ups the engine accepted as queued (submission id -> what was sent), until placed or withdrawn. */
  private readonly ownerQueued = new Map<number, { text: string; refs: readonly AttachmentRef[] }>();
  /** Submission ids the engine has placed (or finished): a submit that returns late must not track these. */
  private readonly settledIds = new Map<number, { status: string; reason?: string }>();
  /** Owner messages withdrawn by an abort, waiting to be re-submitted as the next turn (original order). */
  private withdrawn: Array<{ text: string; refs: readonly AttachmentRef[]; tries?: number }> = [];
  private resubmitting = false;
  private lastActivity = Date.now();
  private toolsInFlight = new Set<string>();
  private stallTimer?: ReturnType<typeof setTimeout>;
  private seenEntries = new Set<EngineSnapshot["entries"][number]["id"]>();
  private readonly subs = new Set<Sub>();
  private readonly waiters = new Set<() => void>();
  /** Answers being submitted: the thread reads busy from the claim until the next turn starts (never idle in between). */
  private answering = 0;
  /** > 0 while a batch is being applied: thread-status is announced when it ends. */
  private holdStatus = 0;
  private lastStatus: ThreadStatus = "idle";
  /** Cards announced as pending (card-pending sent, card-settled not yet): the diff base for card events. */
  private readonly announced = new Set<string>();
  private attached = false;
  private watch?: EngineWatch;
  private mapper?: EventMapper;
  private pump?: Promise<void>;
  /** The engine already had history when this thread was attached (a restart): the thread existed before. */
  hadHistory = false;

  /** Composer settings. A tier change made while a turn runs waits in `pendingTier` and is applied when the turn ends. */
  settings: ThreadSettings;
  private pendingTier?: ThreadTier;

  /** Called for every event this thread emits (a subagent's manager watches its child's turns through it). */
  private readonly observers = new Set<(ev: ThreadEvent) => void>();

  constructor(
    /** Replaced by the owner of a subagent thread as the child's state, step and tokens change. */
    public summary: ThreadSummary,
    readonly conv: EngineConversation,
    private readonly host: ThreadHost,
  ) {
    this.cards = new CardTracker(summary.id);
    this.settings = summary.settings ?? { ...DEFAULT_THREAD_SETTINGS };
  }

  /**
   * Adopt new settings. The tier is applied to the conversation now when no turn is running (or being resumed by an
   * answer); otherwise from the next turn on: the running turn finishes on the model it started with. Throws when the
   * engine refuses the configure (the settings stay as they were).
   */
  async applySettings(next: ThreadSettings): Promise<void> {
    if (next.tier !== this.settings.tier) {
      if (this.running || this.answering > 0) this.pendingTier = next.tier;
      else {
        await this.host.applyTier?.(this.conv, next.tier);
        this.pendingTier = undefined;
      }
    }
    this.settings = next;
  }

  private flushPendingTier(): void {
    const tier = this.pendingTier;
    if (!tier) return;
    this.pendingTier = undefined;
    this.host.applyTier?.(this.conv, tier)?.catch((e) => this.host.onError(e));
  }

  /** Attach the single watcher and start pumping. */
  async attach(): Promise<void> {
    const w = await this.conv.watch();
    this.watch = w;
    this.rebase(w.snapshot, true);
    this.attached = true;
    this.lastStatus = this.status();
    this.hadHistory = w.snapshot.entries.length > 0;
    this.mapper = createEventMapper(w.snapshot);
    this.pump = this.runPump(w);
  }

  async close(): Promise<void> {
    this.disarmWatchdog();
    await this.watch?.stop().catch(() => {});
    await this.pump?.catch(() => {});
  }

  /**
   * Context stats for the header chip (wire shape of GET .../context). `lastAt` becomes an ISO string.
   */
  /** Error of the last manual compaction, until the next one starts. */
  private compactError: string | undefined;

  async contextStats(): Promise<ThreadContext> {
    const s = await this.conv.contextStats();
    return {
      tokens: Math.round(s.tokens),
      ...(s.window ? { window: s.window } : {}),
      ...(s.startAt !== undefined ? { startAt: s.startAt } : {}),
      ...(s.waitAt !== undefined ? { waitAt: s.waitAt } : {}),
      compactions: { count: s.compactions.count, ...(s.compactions.lastAt !== undefined ? { lastAt: new Date(s.compactions.lastAt).toISOString() } : {}) },
      compacting: s.compacting,
      ...(this.compactError ? { compactError: this.compactError } : {}),
    };
  }

  /**
   * Compact now. No busy check: pi-durable places the summary at the next boundary while a turn runs. Resolves once
   * admitted; `onDone` runs when the compaction has finished (the server announces thread-updated then).
   */
  async compact(instructions: string | undefined, onDone: (r: { status: "ok" | "failed"; error?: string }) => void): Promise<void> {
    const { done } = await this.conv.compact(instructions);
    this.compactError = undefined;
    const finish = (r: { status: "ok" | "failed"; error?: string }) => {
      if (r.status === "failed") {
        this.compactError = r.error || "compaction failed";
        console.error(`[wolfd] compaction failed on ${this.summary.id}: ${this.compactError}`);
      }
      try { onDone(r); } catch { /* announcing must not crash the process */ }
    };
    void done.then(finish, (e) => finish({ status: "failed", error: e instanceof Error ? e.message : String(e) }));
  }

  /** Abort the running turn and wait until the pump has seen it end. */
  async abort(): Promise<void> {
    const was = this.running !== null;
    await this.conv.abort();
    if (was) await this.waitFor(() => this.running === null);
  }

  /** A steer or follow-up the engine accepted but has not started yet: another run follows the one that is ending. */
  get hasQueuedInput(): boolean {
    return this.queuedInputs.size > 0;
  }

  get isRunning(): boolean {
    return this.running !== null;
  }

  /** Watch this thread's events (synchronously, in emit order). Returns the unsubscribe. */
  observe(fn: (ev: ThreadEvent) => void): () => void {
    this.observers.add(fn);
    return () => this.observers.delete(fn);
  }

  /** How many messages the thread holds (a resume's submit adds one: recover() compares before and after). */
  messageCount(): number {
    return this.messages.length;
  }

  /** Whether a user message contains `needle` (a steer's delivery id: the parent already took it). */
  hasUserText(needle: string): boolean {
    return this.messages.some((m) => m.role === "user" && m.text.includes(needle));
  }

  /** The text of the newest assistant message (a subagent's final answer once its turn ended), or "". */
  lastAssistantText(): string {
    for (let i = this.messages.length - 1; i >= 0; i--) if (this.messages[i].role === "assistant" && this.messages[i].text.trim()) return this.messages[i].text;
    return "";
  }

  // ------------------------------------------------------------- pump

  private async runPump(w: EngineWatch): Promise<void> {
    try {
      for await (const batch of w.batches) this.applyBatch(batch);
      this.applyMapped(this.mapper!.flush());
    } catch (e) {
      if (!this.host.closing()) this.host.onError(e);
    }
  }

  private applyBatch(batch: readonly EngineEvent[]): void {
    // Status is announced once, after the whole batch is mapped: a dismissal and the turn-start it precedes must not
    // surface as needs-you -> idle -> busy.
    this.holdStatus++;
    try {
      this.applyBatchInner(batch);
    } finally {
      this.holdStatus--;
      this.syncStatus();
    }
  }

  private applyBatchInner(batch: readonly EngineEvent[]): void {
    // Activity = anything from the model, a tool or the run (incl. a retry's error record / new generation). Queued
    // submission records and snapshots are not: an owner typing into a hung turn must not keep it alive.
    if (batch.some((e) => e.type !== "snapshot" && !(e.type === "submission" && (e as { record?: { status?: string } }).record?.status === "queued"))) this.lastActivity = Date.now();
    for (const ev of batch) {
      if (ev.type === "tool_execution_start") this.toolsInFlight.add(String((ev as { toolCallId?: unknown }).toolCallId));
      else if (ev.type === "tool_execution_end") this.toolsInFlight.delete(String((ev as { toolCallId?: unknown }).toolCallId));
      if (ev.type === "snapshot") this.resetMessages(ev.entries);
      else if ((ev.type === "message_end" || ev.type === "tool_execution_end") && ev.entry && !this.seenEntries.has(ev.entry.id)) {
        this.seenEntries.add(ev.entry.id);
        applyEntry(this.messages, ev.entry);
        // A dismissal (a skip, or a plain submit superseding cards) changes thread status: wake waiters.
        const closed = this.cards.apply(ev.entry);
        this.syncCards(closed);
        if ([...closed.values()].some((c) => c !== "answered")) this.notify();
      }
    }
    this.applyMapped(this.mapper!.push(batch));
    // After the mapped events: a turn-end in this batch is seen while the input that follows it still counts as queued.
    for (const ev of batch) {
      if (ev.type !== "submission" || ev.record.type !== "input") continue;
      if (ev.record.status === "queued") this.queuedInputs.add(Number(ev.record.id));
      else this.queuedInputs.delete(Number(ev.record.id));
      this.trackOwnerRecord(ev.record as { id: unknown; status: string; reason?: string });
    }
    this.maybeResubmit();
  }

  /** Keep owner messages: a queued one that the engine withdraws (abort) is remembered, a placed one is forgotten. */
  private trackOwnerRecord(r: { id: unknown; status: string; reason?: string }): void {
    const id = Number(r.id);
    if (r.status === "queued") return;
    const kept = this.ownerQueued.get(id);
    this.ownerQueued.delete(id);
    if (kept) {
      if (r.status === "unanswered" && r.reason === "aborted") this.withdrawn.push(kept);
      return;
    }
    // Not tracked (yet): a submit() may still be awaiting the engine. Remember the outcome for it, bounded.
    this.settledIds.set(id, { status: r.status, ...(r.reason ? { reason: r.reason } : {}) });
    if (this.settledIds.size > 200) this.settledIds.delete(this.settledIds.keys().next().value as number);
  }

  /** After an abort settled (nothing running), send the withdrawn owner messages as one next message. */
  private maybeResubmit(): void {
    if (this.withdrawn.length === 0 || this.running || this.resubmitting || this.host.closing()) return;
    const items = this.withdrawn;
    this.withdrawn = [];
    this.resubmitting = true;
    const text = items.map((i) => i.text).join("\n\n");
    const refs = [...new Map(items.flatMap((i) => [...i.refs]).map((r) => [r.id, r])).values()];
    const tries = Math.max(0, ...items.map((i) => i.tries ?? 0));
    // Deferred: the batch that ended the turn is still being applied.
    setTimeout(() => {
      this.submit(text, "followUp", refs, { resubmit: true })
        .catch((e) => {
          this.host.onError(e);
          const turnId = this.running?.turnId;
          this.emit({ type: "error", ...(turnId ? { turnId } : {}), message: `Could not re-send your message after the abort${tries < 1 ? " (will retry once)" : ""}: ${JSON.stringify(text)}` });
          if (tries < 1) this.withdrawn.unshift({ text, refs, tries: tries + 1 });
        })
        .finally(() => {
          this.resubmitting = false;
          this.maybeResubmit();
        });
    }, 0);
  }

  // --- stall watchdog ---
  private stallMs(): number {
    return this.host.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  }

  private armWatchdog(delay = this.stallMs()): void {
    clearTimeout(this.stallTimer);
    if (this.stallMs() <= 0 || this.host.closing()) return;
    this.stallTimer = setTimeout(() => this.checkStall(), Math.max(delay, 1));
    this.stallTimer.unref?.();
  }

  private disarmWatchdog(): void {
    clearTimeout(this.stallTimer);
    this.stallTimer = undefined;
  }

  private checkStall(): void {
    const turn = this.running;
    if (!turn || this.host.closing()) return;
    const limit = this.stallMs();
    // A tool task running (a long bash command) is not silence from the model: check again later.
    if (this.toolsInFlight.size > 0) return this.armWatchdog(limit);
    const idle = Date.now() - this.lastActivity;
    if (idle < limit) return this.armWatchdog(limit - idle);
    const follow = this.ownerQueued.size > 0 || this.withdrawn.length > 0;
    this.emit({ type: "error", turnId: turn.turnId, message: `Turn stalled: no activity for ${Math.round(idle / 1000)}s. Aborting it.${follow ? " Queued messages will follow." : ""}` });
    void this.abort()
      .catch((e) => this.host.onError(e))
      .finally(() => {
        if (this.running?.turnId === turn.turnId) this.armWatchdog(limit);
      });
  }
  // --- end stall watchdog ---

  /** Re-base thread state on an engine snapshot. `initial`: synthesize the in-flight turn into the buffer. */
  private rebase(snap: EngineSnapshot, initial: boolean): void {
    this.resetMessages(snap.entries);
    if (!snap.run) {
      this.running = null;
      return;
    }
    const turnId = `turn-${Number(snap.run.inputs[0])}`;
    if (initial) {
      this.emit({ type: "turn-start", turnId });
      const partial = textOf(snap.generation?.message);
      if (partial) this.emit({ type: "text-delta", turnId, text: partial });
    } else {
      this.running = { turnId };
    }
    // A tool still executing in the snapshot (reattach / resync) must not look like model silence.
    this.toolsInFlight = new Set(((snap as unknown as { tools?: Array<{ callId: string; status?: string }> }).tools ?? []).filter((t) => t.status !== "done").map((t) => t.callId));
    this.lastActivity = Date.now();
  }

  /** Messages before this index predate the newest compaction (initial page never starts after it). */
  private compactionIndex: number | undefined;

  private resetMessages(entries: EngineSnapshot["entries"]): void {
    this.messages = messagesFromEntries(entries);
    // Index of the first message after the newest compaction marker in the snapshot (best effort: undefined when none is visible).
    let marker = -1;
    entries.forEach((e, i) => { if (/compaction/i.test(String(e.kind))) marker = i; });
    this.compactionIndex = marker < 0 ? undefined : messagesFromEntries(entries.slice(0, marker + 1)).length;
    this.seenEntries = new Set(entries.map((e) => e.id));
    this.cards.reset(entries);
    // The first baseline (attach) announces nothing: a connection's baseline carries the pending cards.
    if (this.attached) this.syncCards();
    else for (const p of this.cards.raisedCards()) this.announced.add(p.callId);
  }


  /**
   * Announce card changes as thread events (so an open thread shows the card without waiting for the turn to settle)
   * and wolf events (so the needs-you list sees every thread). Diffs the tracker against what was announced, so each
   * raise and each settle is announced exactly once whichever path (pump entry, answer ack) sees it first.
   */
  private syncCards(closedBy: ReadonlyMap<string, CardClosed> = new Map()): void {
    const live = new Map(this.cards.raisedCards().map((p) => [p.callId, p]));
    for (const callId of [...this.announced]) {
      if (live.has(callId)) continue;
      this.announced.delete(callId);
      const closed = closedBy.get(callId) ?? "answered";
      const outcome = closed === "answered" ? "answered" : "dismissed";
      if (!this.isChild) this.host.emitWolf({ type: "card-settled", threadId: this.summary.id, callId, outcome, closed });
      this.emit({ type: "card-settled", callId, outcome, closed });
    }
    for (const [callId, card] of live) {
      if (this.announced.has(callId)) continue;
      this.announced.add(callId);
      if (!this.isChild) this.host.emitWolf({ type: "card-pending", card });
      this.emit({ type: "card-pending", card });
    }
  }

  /** A subagent: its questions go to the parent, so its cards never reach the operator's needs-you. */
  get isChild(): boolean {
    return this.summary.kind === "subagent";
  }

  /** A held answer changed: the card is still pending, with the new answer. */
  private announceHeld(callId: string): void {
    const card = this.cards.get(callId);
    if (!card) return;
    this.emit({ type: "card-pending", card });
    if (!this.isChild) this.host.emitWolf({ type: "card-pending", card });
  }

  /** Thread status is derived; announce it whenever the derivation changes. */
  private syncStatus(): void {
    if (this.holdStatus > 0) return;
    const status = this.status();
    if (status === this.lastStatus) return;
    this.lastStatus = status;
    this.host.emitWolf({ type: "thread-status", threadId: this.summary.id, status });
  }

  private applyMapped(events: MappedEvent[]): void {
    for (const ev of events) {
      if (ev.type === "resync") {
        if (ev.snapshot) this.rebase(ev.snapshot, false);
        if (ev.correction) this.correctBuffer(ev.correction);
        const snap = this.snapshotEvent();
        for (const s of [...this.subs]) s(snap);
        this.notify();
      } else this.emit(ev);
    }
  }

  /**
   * A diverged retry: the buffered deltas of the current message are stale. Rewrite them in place (ids stay, so
   * replay keeps working): the earliest stale delta carries the authoritative text, the rest are blanked.
   */
  private correctBuffer(c: NonNullable<ResyncDraft["correction"]>): void {
    const fix = (type: "text-delta" | "thinking-delta", stale: string, final: string) => {
      if (final === stale) return;
      const hit: ThreadEvent[] = [];
      let n = 0;
      for (let i = this.buffer.length - 1; i >= 0 && n < stale.length; i--) {
        const e = this.buffer[i];
        if (e.type === type && e.turnId === c.turnId) {
          hit.push(e);
          n += e.text.length;
        }
      }
      // Earliest stale delta carries the authoritative text (empty when the side shrank to nothing), the rest are blanked.
      hit.forEach((e, i) => {
        (e as { text: string }).text = i === hit.length - 1 ? final : "";
      });
      // Nothing stale was buffered for this side: the authoritative text has to be emitted as a new delta.
      if (hit.length === 0 && final !== "") this.emit({ type, turnId: c.turnId, text: final });
    };
    fix("text-delta", c.staleText, c.text);
    fix("thinking-delta", c.staleThinking, c.thinking);
  }

  private emit(draft: ThreadEventDraft): void {
    if (draft.type === "turn-start") {
      this.buffer = [];
      this.running = { turnId: draft.turnId };
      this.turnStarts++;
      this.lastActivity = Date.now();
      this.toolsInFlight.clear();
      this.armWatchdog();
    }
    const actor: Actor = draft.type === "turn-start" ? OPERATOR : draft.type === "error" ? SYSTEM : { id: this.host.name, kind: "wolf" };
    const full = stampEvent(draft, { threadId: this.summary.id, id: ++this.seq, actor });
    this.buffer.push(full);
    if (draft.type === "turn-end") {
      this.running = null;
      this.disarmWatchdog();
      this.toolsInFlight.clear();
      this.flushPendingTier();
    }
    for (const s of [...this.subs]) s(full);
    for (const o of [...this.observers]) {
      try {
        o(full);
      } catch (e) {
        this.host.onError(e);
      }
    }
    this.notify();
  }

  private notify(): void {
    this.syncStatus();
    for (const w of [...this.waiters]) w();
  }

  /** Resolves when `pred` holds (checked after every pump event) or after the settle timeout. */
  private waitFor(pred: () => boolean): Promise<void> {
    if (pred()) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        if (!pred()) return;
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(() => {
        this.waiters.delete(done);
        resolve();
      }, this.host.settleMs);
      this.waiters.add(done);
    });
  }

  status(): ThreadStatus {
    // While an answer is submitted the thread is busy (needs-you never blips through idle); the dot and the
    // list/baseline agree because both read pending().
    return this.running || this.answering > 0 ? "busy" : this.cards.pending().length > 0 && !this.isChild ? "needs-you" : "idle";
  }

  threadSummary(): ThreadSummary {
    return { ...this.summary, status: this.status(), ...this.boundItemField(), ...(this.isChild ? {} : { settings: this.settings }) };
  }

  // --- feature progress: bound item ---
  /** `boundItem`: the item the conversation is bound to now (read fresh), when it is not the feature the thread was opened for. */
  private boundItemField(): { boundItem?: string } {
    const den = this.host.den;
    if (!den || this.isChild || !/^\d+$/.test(this.conv.id)) return {};
    const now = readBindingFile(den, Number(this.conv.id))?.workId;
    return now && now !== this.summary.boundWorkItem ? { boundItem: now } : {};
  }
  // --- end feature progress ---

  /** `opts.limit` absent = the whole transcript; see `pageRange` for the paging rules. Only the page is copied/serialised. */
  detail(opts: { limit?: number; before?: string } = {}): ThreadDetail {
    const den = this.host.den;
    const attachmentsOf = (m: ThreadMessage) => {
      const list = den && m.role === "user" ? attachmentsInText(den, this.summary.id, m.text) : [];
      return list.length ? { attachments: list } : {};
    };
    const pendingCards = this.cards.pending();
    const page = pageRange(this.messages, { ...opts, compactionIndex: this.compactionIndex, requiredCallIds: pendingCards.map((c) => c.callId) });
    const messages = this.messages.slice(page.start, page.end).map((m) => ({
      ...m,
      // The `{...c}` copy drops messages.ts's per-call WeakMap entries (uncapped args); fine, the copy is output-only.
      ...(m.tools ? { tools: m.tools.map((c) => ({ ...c })) } : {}),
      ...(m.objects ? { objects: m.objects.map((o) => ({ ...o })) } : {}),
      ...attachmentsOf(m),
    }));
    const paged = opts.limit !== undefined ? { hasMore: page.hasMore, ...(page.cursor ? { cursor: page.cursor } : {}) } : {};
    return { ...this.threadSummary(), messages, busy: this.running !== null, lastEventId: this.seq, ...(pendingCards.length ? { pendingCards } : {}), ...paged };
  }

  async submit(text: string, whenBusy: "steer" | "followUp" | "reject", refs: readonly AttachmentRef[] = [], opts: { internal?: boolean; resubmit?: boolean } = {}): Promise<SubmitAck> {
    const before = this.turnStarts;
    const textOnly = text;
    // At a turn boundary (nothing running) an operator/card message carries one coalesced notice of what changed on the
    // bound item. Machine submits (subagent deliveries) leave it for the next one. A slow Work API means no notice.
    let notice: PendingNotice | undefined;
    if (!this.running && !this.isChild && !opts.internal && !opts.resubmit && this.host.taskNotice) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        notice = await Promise.race([
          this.host.taskNotice(String(this.conv.id)),
          new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), this.host.taskNoticeDeadlineMs ?? 1500); }),
        ]);
      } catch {
        notice = undefined;
      } finally {
        clearTimeout(timer);
      }
    }
    // (Only when idle, re-checked after the await: a turn may have started. A steer/followUp during a run finds nothing
    // pending, the run's first message superseded them, and carries no notice.)
    if (this.running) notice = undefined;
    else {
      // Order: superseded notes, then the notice, then the text (stripSupersededNotes / stripTaskNotice peel them in that order).
      text = supersededNotes(this.cards.pending().map((p) => ({ tool: p.card.tool, callId: p.callId }))) + withTaskNotice(notice?.text ?? "", text);
    }
    let input: SubmitOptions["input"] = text;
    if (refs.length > 0) {
      if (!this.host.den) throw new HttpError("invalid_request", "this wolf has no den to read attachments from");
      try {
        input = inlineAttachments(this.host.den, this.summary.id, text, refs);
      } catch (e) {
        if (e instanceof AttachmentError) throw new HttpError("invalid_request", e.message);
        throw e;
      }
    }
    let r;
    try {
      r = await this.conv.submit({ input, whenBusy });
    } catch (e) {
      if (e instanceof EngineBusyError) throw new HttpError("busy", `thread ${this.summary.id} is busy`);
      throw new HttpError("engine_error", e instanceof Error ? e.message : "submit failed");
    }
    notice?.commit();
    if (!opts.internal && (r.disposition === "steered" || r.disposition === "queued")) {
      const id = Number(r.messageId);
      if (Number.isFinite(id)) {
        const settled = this.settledIds.get(id);
        this.settledIds.delete(id);
        if (!settled) this.ownerQueued.set(id, { text: textOnly, refs });
        else if (settled.status === "unanswered" && settled.reason === "aborted") {
          // The withdrawal was pumped before this submit returned.
          this.withdrawn.push({ text: textOnly, refs });
          this.maybeResubmit();
        }
      }
    }
    if (refs.length > 0 && this.host.den) {
      try {
        recordSubmission(this.host.den, this.summary.id, r.messageId, refs);
      } catch {
        /* the sidecar is best-effort: history falls back to the text lines */
      }
    }
    if (r.disposition === "started") await this.waitFor(() => this.turnStarts > before);
    return { messageId: r.messageId, disposition: r.disposition };
  }

  /**
   * Answer a pending card. The answer is a submission placed as a card-answer entry: the next turn starts with it as
   * input, and the history folds it onto the call that raised the card. While sibling cards of the turn still wait
   * the answer is held and the ack is `queued`.
   */
  async answerCard(callId: string, rawAnswers: CardAnswers): Promise<SubmitAck> {
    if (this.running) throw new HttpError("busy", `thread ${this.summary.id} is busy`);
    const pending = this.cards.get(callId);
    if (!pending) throw new HttpError("not_found", `card ${callId}`);
    const bad = validateAnswers(pending.card, rawAnswers);
    if (bad) throw new HttpError("invalid_request", bad);
    const answers = dropHiddenAnswers(pending.card, rawAnswers);
    // Synchronous from here to the claim: a concurrent answer for the same call finds it claimed (404).
    return this.resolveCard(callId, this.cards.answer(callId, answers));
  }

  /** Skip a pending card: the agent is told, and a skip counts as the card's resolution among its siblings. */
  async skipCard(callId: string): Promise<SubmitAck> {
    if (this.running) throw new HttpError("busy", `thread ${this.summary.id} is busy`);
    const pending = this.cards.get(callId);
    if (!pending) throw new HttpError("not_found", `card ${callId}`);
    // A repeated skip of an already held-skipped card changes nothing: no second announcement.
    if (pending.heldSkip) return { messageId: `card-${callId}`, disposition: "queued" };
    return this.resolveCard(callId, this.cards.skip(callId));
  }

  /** After an answer or skip was recorded: hold it while siblings wait, else submit the whole turn's resolutions. */
  private async resolveCard(callId: string, ready: ReturnType<CardTracker["answer"]>): Promise<SubmitAck> {
    if (!ready) {
      this.announceHeld(callId);
      this.notify();
      return { messageId: `card-${callId}`, disposition: "queued" };
    }
    const ids = ready.map((r) => r.callId);
    const before = this.turnStarts;
    this.answering++;
    this.syncStatus();
    try {
      return await this.submitAnswers(ready, ids, before);
    } finally {
      this.answering--;
      this.syncStatus();
    }
  }

  private async submitAnswers(ready: ReturnType<CardTracker["answer"]> & object, ids: string[], before: number): Promise<SubmitAck> {
    let r;
    try {
      r = await this.conv.submit({
        input: answerText(ready),
        whenBusy: "reject",
        cardAnswers: { cards: ready.map(({ callId: id, answers: a, skipped }) => ({ callId: id, answers: a, ...(skipped ? { skipped } : {}) })) },
      });
    } catch (e) {
      this.cards.release(ids);
      if (e instanceof EngineBusyError) throw new HttpError("busy", `thread ${this.summary.id} is busy`);
      throw new HttpError("engine_error", e instanceof Error ? e.message : "submit failed");
    }
    this.cards.settle(ids);
    this.syncCards(new Map(ready.map((c): [string, CardClosed] => [c.callId, c.skipped ? "skipped" : "answered"])));
    if (r.disposition === "started") await this.waitFor(() => this.turnStarts > before);
    return { messageId: r.messageId, disposition: r.disposition };
  }

  // ----------------------------------------------------------- stream

  private inFlight(): InFlightPartial | undefined {
    if (!this.running) return undefined;
    let text = "";
    let thinking = "";
    for (const e of this.buffer) {
      if (e.type === "text-delta") text += e.text;
      else if (e.type === "thinking-delta") thinking += e.text;
    }
    return { turnId: this.running.turnId, text, ...(thinking ? { thinking } : {}) };
  }

  private snapshotEvent(): ThreadEvent {
    const inFlight = this.inFlight();
    return {
      type: "snapshot",
      id: Math.max(this.seq, 1),
      threadId: this.summary.id,
      at: new Date().toISOString(),
      actor: SYSTEM,
      upToId: this.seq,
      thread: this.detail(),
      ...(inFlight ? { inFlight } : {}),
    };
  }

  stream(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const from = resumeCursor(req, url);

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    const frame = (ev: ThreadEvent) => res.write(`id: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`);
    const done = () => {
      res.write(`data: ${SSE_DONE}\n\n`);
      res.end();
    };

    let replay: ThreadEvent[];
    let snapshot: ThreadEvent | undefined;
    const firstId = this.buffer[0]?.id;
    if (from === undefined) {
      replay = [...this.buffer];
    } else {
      // The buffer covers ids [firstId, seq]. Resuming at firstId-1 or later is gap-free.
      const stale = from > this.seq || (firstId === undefined ? from < this.seq : from < firstId - 1);
      if (stale) {
        replay = [];
        snapshot = this.snapshotEvent();
      } else {
        replay = this.buffer.filter((e) => e.id > from);
      }
    }

    if (snapshot) frame(snapshot);
    for (const ev of replay) {
      frame(ev);
      if (ev.type === "turn-end") return done();
    }
    if (!this.running) return done();

    const sub: Sub = (ev) => {
      frame(ev);
      if (ev.type === "turn-end") {
        this.subs.delete(sub);
        done();
      }
    };
    this.subs.add(sub);
    res.on("close", () => this.subs.delete(sub));
  }
}

/** `Last-Event-ID` header, else `?from=`; anything non-numeric is no cursor. */
function resumeCursor(req: IncomingMessage, url: URL): number | undefined {
  const raw = req.headers["last-event-id"] ?? url.searchParams.get("from");
  const rawStr = Array.isArray(raw) ? raw[0] : raw;
  const n = rawStr == null || rawStr.trim() === "" ? NaN : Number(rawStr);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

function textOf(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}
