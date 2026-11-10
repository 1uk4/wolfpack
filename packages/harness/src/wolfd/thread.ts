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
  type PendingCard,
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
import { AttachmentError, attachmentExists, attachmentsInText, imageParts, inlineAttachments, recordSubmission } from "./attachments.js";
import type { PendingNotice } from "./task-notice.js";
import { withTaskNotice } from "./task-notice.js";
import { ATTACHMENT_MAX_PER_SUBMIT, askSupersedeDetail, pageCard, stepsKey, visibleFields, type CardNoteBody, type SaveCardPageBody, type SubmitCardBody } from "@wolfpack/protocol";
import { isImageOnly } from "./card-kinds/types.js";
import { CardTracker, sourceOf, answerText, attachmentIds, questionNumbers, type ReadyAnswer, dropHiddenAnswers, supersededNotes, validateAnswers } from "./cards.js";
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
  /** The threads above this one (its parent first), by `parentThreadId`. Unset: none. */
  ancestorsOf?(id: string): ThreadRuntime[];
  /** Every thread below this one (children, then theirs). Unset: none. */
  descendantsOf?(id: string): ThreadRuntime[];
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

/** An owner submission the engine accepted as queued: a chat message (text, refs) or a card answer (cardAnswers). */
interface QueuedOwner {
  text: string;
  refs: readonly AttachmentRef[];
  cardAnswers?: ReadyAnswer[];
}

const cardAnswersOf = (ready: readonly ReadyAnswer[]) => ({
  cards: ready.map(({ callId: id, answers: a, skipped, note }) => ({ callId: id, answers: a, ...(skipped ? { skipped } : {}), ...(note && (note.text || note.attachments?.length) ? { note } : {}) })),
});

export class ThreadRuntime {
  readonly cards: CardTracker;
  private seq = 0;
  private buffer: ThreadEvent[] = [];
  private running: { turnId: string; startedAt: string } | null = null;
  private turnStarts = 0;
  private messages: ThreadMessage[] = [];
  private queuedInputs = new Set<number>();
  /** Owner steers/follow-ups the engine accepted as queued (submission id -> what was sent), until placed or withdrawn. */
  private readonly ownerQueued = new Map<number, QueuedOwner>();
  /** Submission ids the engine has placed (or finished): a submit that returns late must not track these. */
  private readonly settledIds = new Map<number, { status: string; reason?: string }>();
  /** Owner messages withdrawn by an abort, waiting to be re-submitted as the next turn (original order). */
  private withdrawn: Array<QueuedOwner & { tries?: number }> = [];
  private resubmitting = false;
  private lastActivity = Date.now();
  private toolsInFlight = new Set<string>();
  private stallTimer?: ReturnType<typeof setTimeout>;
  private seenEntries = new Set<EngineSnapshot["entries"][number]["id"]>();
  private readonly subs = new Set<Sub>();
  private readonly waiters = new Set<() => void>();
  /** Answers being submitted: the thread reads busy from the claim until the next turn starts (never idle in between). */
  private answering = 0;
  /** When the oldest in-progress card answer began: the turn it starts counts from here, so the busy gap has a start time. */
  private answerStartedAt: string | null = null;
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
    this.cards = new CardTracker(summary.id, (card) => sourceOf(card, this.summary));
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
      else if (
        ((ev.type === "message_end" || ev.type === "tool_execution_end" || (ev as { entry?: { kind?: string } }).entry?.kind === "pi.compaction") &&
          (ev as Extract<typeof ev, { type: "message_end" }>).entry) &&
        !this.seenEntries.has((ev as Extract<typeof ev, { type: "message_end" }>).entry.id)
      ) {
        // (a compaction entry may arrive on any entry-carrying event; it is applied once, like a message)
        const entry = (ev as Extract<typeof ev, { type: "message_end" }>).entry;
        this.seenEntries.add(entry.id);
        applyEntry(this.messages, entry);
        // A dismissal (a skip, or a plain submit superseding cards) changes thread status: wake waiters.
        const closed = this.cards.apply(entry);
        this.syncCards(closed);
        const changedIds = this.cards.takeChanged();
        for (const id of changedIds) this.announceHeld(id);
        for (const why of this.cards.takeLateRevise()) {
          this.submit(`Note: your earlier ask_revise was NOT applied: ${why}`, "followUp", [], { internal: true }).catch((e) => this.host.onError(e));
        }
        if (changedIds.length || [...closed.values()].some((c) => c !== "answered")) this.notify();
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
    // Withdrawn card answers go back as card answers (the model must still get them as the card's answer), ahead of text.
    const answerItem = this.withdrawn.find((i) => i.cardAnswers);
    if (answerItem) {
      this.withdrawn = this.withdrawn.filter((i) => i !== answerItem);
      this.resubmitting = true;
      const cardAnswers = answerItem.cardAnswers!;
      setTimeout(() => {
        this.resubmitCardAnswers(cardAnswers)
          .catch((e) => {
            this.host.onError(e);
            const retry = (answerItem.tries ?? 0) < 1;
            this.emit({ type: "error", ...(this.running ? { turnId: this.running.turnId } : {}), message: `Could not re-send your card answer after the abort${retry ? " (will retry once)" : ": the question is open again, please answer it again"}.` });
            if (retry) this.withdrawn.unshift({ ...answerItem, tries: (answerItem.tries ?? 0) + 1 });
            else {
              this.cards.reraise(cardAnswers);
              this.syncCards();
              this.notify();
            }
          })
          .finally(() => {
            this.resubmitting = false;
            this.maybeResubmit();
          });
      }, 0);
      return;
    }
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

  private async resubmitCardAnswers(ready: ReadyAnswer[]): Promise<void> {
    const r = await this.conv.submit({ input: this.answerInput(ready), whenBusy: "followUp", cardAnswers: cardAnswersOf(ready) });
    this.trackQueued(r, { text: "", refs: [], cardAnswers: ready });
  }

  /** Remember an accepted steer/queue so an abort's withdrawal can re-send it (shared by chat messages and card answers). */
  private trackQueued(r: { messageId: string; disposition: string }, item: QueuedOwner): void {
    if (r.disposition !== "steered" && r.disposition !== "queued") return;
    const id = Number(r.messageId);
    if (!Number.isFinite(id)) return;
    const settled = this.settledIds.get(id);
    this.settledIds.delete(id);
    if (!settled) this.ownerQueued.set(id, item);
    else if (settled.status === "unanswered" && settled.reason === "aborted") {
      // The withdrawal was pumped before this submit returned.
      this.withdrawn.push(item);
      this.maybeResubmit();
    }
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
    this.emit({ type: "error", turnId: turn.turnId, message: `Turn stalled: no activity for ${Math.round(idle / 1000)}s. Aborting it.${follow ? " Queued messages and card answers will follow." : ""}` });
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
    // The engine snapshot's `run` is only its input ids: it exposes no start time. So after a wolfd restart mid-turn the
    // turn's timer restarts at the resume (the first rebase), not at the original start.
    if (initial) {
      this.emit({ type: "turn-start", turnId });
      const partial = textOf(snap.generation?.message);
      if (partial) this.emit({ type: "text-delta", turnId, text: partial });
    } else {
      this.running = { turnId, startedAt: this.running?.turnId === turnId ? this.running.startedAt : new Date().toISOString() };
    }
    // A tool still executing in the snapshot (reattach / resync) must not look like model silence.
    this.toolsInFlight = new Set(((snap as unknown as { tools?: Array<{ callId: string; status?: string }> }).tools ?? []).filter((t) => t.status !== "done").map((t) => t.callId));
    this.lastActivity = Date.now();
  }

  private resetMessages(entries: EngineSnapshot["entries"]): void {
    this.messages = messagesFromEntries(entries);
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
      this.host.emitWolf({ type: "card-settled", threadId: this.summary.id, callId, outcome, closed });
      this.emit({ type: "card-settled", callId, outcome, closed });
      this.relayToAncestors({ type: "card-settled", callId, outcome, closed });
    }
    for (const [callId, card] of live) {
      if (this.announced.has(callId)) continue;
      this.announced.add(callId);
      this.host.emitWolf({ type: "card-pending", card });
      this.emit({ type: "card-pending", card });
      this.relayToAncestors({ type: "card-pending", card });
    }
    this.refreshAncestorStatus();
  }

  /** A descendant's card event also goes on this thread's stream (the parent's sheet queues it). */
  private relayToAncestors(draft: ThreadEventDraft): void {
    for (const a of this.host.ancestorsOf?.(this.summary.id) ?? []) a.emit(draft);
  }

  /** A descendant's card came or went: the parent's needs-you status may have changed. */
  private refreshAncestorStatus(): void {
    for (const a of this.host.ancestorsOf?.(this.summary.id) ?? []) a.syncStatus();
  }

  /** A subagent. Gates `status()`: a child never goes needs-you for its own or its children's cards (the top thread's sheet carries them). */
  get isChild(): boolean {
    return this.summary.kind === "subagent";
  }

  /** A held answer changed: the card is still pending, with the new answer. */
  private announceHeld(callId: string): void {
    const card = this.cards.get(callId);
    if (!card) return;
    this.emit({ type: "card-pending", card });
    this.host.emitWolf({ type: "card-pending", card });
    this.relayToAncestors({ type: "card-pending", card });
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
      // A card-answer turn counts from the answer (the thread was busy from then). Otherwise now. The event carries it so
      // live and replayed streams (the buffer) give the console the server's clock.
      const startedAt = this.answerStartedAt ?? new Date().toISOString();
      draft = { ...draft, startedAt };
      this.running = { turnId: draft.turnId, startedAt };
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
    return this.running || this.answering > 0 ? "busy" : !this.isChild && (this.cards.pending().length > 0 || this.descendantCards().length > 0) ? "needs-you" : "idle";
  }

  /** Pending cards of every thread below this one. */
  private descendantCards(): PendingCard[] {
    return (this.host.descendantsOf?.(this.summary.id) ?? []).flatMap((d) => d.cards.pending());
  }

  /** `turnStartedAt`: the running turn's start, or the start of the card answer that is about to begin one. */
  private turnStartedField(): { turnStartedAt?: string } {
    const at = this.running?.startedAt ?? (this.answering > 0 ? this.answerStartedAt : null);
    return at ? { turnStartedAt: at } : {};
  }

  threadSummary(): ThreadSummary {
    return { ...this.summary, status: this.status(), ...this.turnStartedField(), ...this.boundItemField(), ...(this.isChild ? {} : { settings: this.settings }) };
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
    const ownCards = this.cards.pending();
    const pendingCards = [...ownCards, ...this.descendantCards()].map((c, i) => ({ c, i }))
      .sort((a, b) => Date.parse(a.c.raisedAt) - Date.parse(b.c.raisedAt) || a.i - b.i) // by instant (Z and +00:00 forms mix), stable on ties
      .map((x) => x.c);
    const page = pageRange(this.messages, { ...opts, requiredCallIds: ownCards.map((c) => c.callId) });
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
    // A superseded questionnaire (paged ask) always says how far it got, even mid-turn: the owner's partial answers travel with the message.
    const pagedNotes = supersededNotes(this.cards.pending().filter((p) => p.card.paged).map((p) => this.supersededOf(p)));
    if (this.running) {
      notice = undefined;
      text = pagedNotes + text;
    } else {
      // Order: superseded notes, then the notice, then the text (stripSupersededNotes / stripTaskNotice peel them in that order).
      text = supersededNotes(this.cards.pending().map((p) => this.supersededOf(p))) + withTaskNotice(notice?.text ?? "", text);
    }
    let input: SubmitOptions["input"] = text;
    // The questionnaires this message supersedes: their drafted images ride along (the note only says they are below).
    // The message's own images come first and are never repeated as drafts; together they stay within one turn's cap.
    const ownIds = new Set(refs.map((r) => r.id));
    const draftParts = this.draftImages(this.running ? this.cards.pending().filter((p) => p.card.paged) : this.cards.pending(), ownIds, ATTACHMENT_MAX_PER_SUBMIT - ownIds.size);
    if (draftParts.length) input = [{ type: "text", text }, ...draftParts];
    if (refs.length > 0) {
      if (!this.host.den) throw new HttpError("invalid_request", "this wolf has no den to read attachments from");
      try {
        input = [...inlineAttachments(this.host.den, this.summary.id, text, refs), ...draftParts];
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
    if (!opts.internal) this.trackQueued(r, { text: textOnly, refs });
    // An owner message typed mid-turn supersedes the pending cards now (the engine places it later, after the tool round).
    // Only once the engine accepted it: a rejected submit must leave the cards answerable.
    if (!opts.internal && !opts.resubmit && (r.disposition === "steered" || r.disposition === "queued")) this.supersedePending();
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

  private supersededOf(p: PendingCard): { tool: string; callId: string; detail?: string; paged?: true } {
    const base = { tool: p.card.tool, callId: p.callId };
    // The partial answers AND the text typed for the current page (draft) travel with the note: a draft is not "unanswered".
    if (!p.card.paged) return base;
    // Only images that will actually travel with the message are mentioned in the note.
    const draft = p.draft && Object.fromEntries(Object.entries(p.draft).map(([id, a]) => {
      const { attachments: _drop, ...rest } = a as { attachments?: string[] };
      const live = this.liveAttachments(attachmentIds(a));
      return [id, live.length ? { ...rest, attachments: live } : rest];
    })) as CardAnswers | undefined;
    return { ...base, paged: true, detail: askSupersedeDetail(p.card, p.pageAnswers, p.reached ?? 0, draft) };
  }

  /** What an ask_revise of `callId` may do now (see CardTracker.reviseTarget). */
  reviseTarget(callId: string): { usedIds: string[] } | { problem: string } {
    const t = this.cards.reviseTarget(callId);
    return "problem" in t ? t : { usedIds: t.usedIds };
  }

  /** The page of a paged card the request names, or the HttpError for an unknown/closed card, a non-paged card or a page out of range. */
  private pagedCard(callId: string, page?: number): PendingCard {
    const pending = this.cards.get(callId);
    if (!pending) {
      // Being submitted right now: conflict, not "unknown card".
      if (this.cards.isClaimed(callId)) throw new HttpError("conflict", `card ${callId} is already being submitted`);
      throw new HttpError("not_found", `card ${callId}`);
    }
    if (!pending.card.paged) throw new HttpError("invalid_request", `card ${callId} is not a paged questionnaire`);
    const n = pending.card.steps?.length ?? 1;
    if (page !== undefined && (!Number.isInteger(page) || page < 0 || page >= n)) throw new HttpError("invalid_request", `page ${page} is out of range (0-${n - 1})`);
    return pending;
  }

  private checkStepsKey(pending: PendingCard, key: string | undefined): void {
    if (key !== undefined && key !== stepsKey(pending.card)) throw new HttpError("conflict", `the pages of card ${pending.callId} changed (ask_revise); reload the questionnaire`);
  }

  /** The draft changed: tell every client (card-pending with the full card) and wake waiters. */
  private draftChanged(callId: string): void {
    this.announceHeld(callId);
    this.notify();
  }

  /**
   * Save one page of a paged (`ask`) card as a draft and move the cursor (Next / Back). Nothing reaches the agent.
   * Shape only: required answers are checked at submit.
   */
  saveCardPage(callId: string, page: number, body: SaveCardPageBody): void {
    const pending = this.pagedCard(callId, page);
    this.checkStepsKey(pending, body.stepsKey);
    const n = pending.card.steps?.length ?? 1;
    const goto = body.goto ?? Math.min(page + 1, n - 1);
    if (goto >= n) throw new HttpError("invalid_request", `goto ${goto} is out of range (0-${n - 1})`);
    const sub = pageCard(pending.card, page)!;
    const answers = dropHiddenAnswers(sub, body.answers);
    const bad = this.shapeProblem(sub, answers);
    if (bad) throw new HttpError("invalid_request", bad);
    const problem = this.cards.savePage(callId, page, answers, goto);
    if (problem === "not_found") throw new HttpError("not_found", `card ${callId}`);
    if (problem) throw new HttpError("invalid_request", problem);
    this.draftChanged(callId);
  }

  /** Each given answer must be valid for its question (required answers may be missing). */
  private shapeProblem(card: PendingCard["card"], answers: CardAnswers): string | undefined {
    const known = new Set(card.fields.map((f) => f.id));
    const extra = Object.keys(answers).find((k) => !known.has(k));
    if (extra) return `unknown field "${extra}"`;
    for (const f of card.fields) {
      const a = answers[f.id];
      if (a === undefined) continue;
      const bad = validateAnswers({ ...card, fields: [{ ...f, optional: true }] }, { [f.id]: a });
      if (bad) return bad;
    }
    return undefined;
  }

  /** Store (or clear) the owner's note on a paged card. */
  putCardNote(callId: string, body: CardNoteBody): void {
    this.pagedCard(callId);
    const ids = [...new Set(body.attachments ?? [])];
    if (ids.length > 0 && !this.host.den) throw new HttpError("invalid_request", "this wolf has no den to read attachments from");
    const problem = this.cards.setNote(callId, { ...(body.text ? { text: body.text } : {}), ...(ids.length ? { attachments: ids } : {}) }, (id) => attachmentExists(this.host.den!, this.summary.id, id));
    if (problem === "not_found") throw new HttpError("not_found", `card ${callId}`);
    if (problem) throw new HttpError("invalid_request", problem);
    this.draftChanged(callId);
  }

  /**
   * Submit a paged card: ONE card-answer carrying every page's answers and the note. All pages' required questions
   * are checked; the 400 names the missing ones by number and label.
   */
  async submitCard(callId: string, body: SubmitCardBody = {}): Promise<SubmitAck> {
    const pending = this.pagedCard(callId);
    this.checkStepsKey(pending, body.stepsKey);
    const card = pending.card;
    const last = pageCard(card, pending.pageIndex ?? 0)!;
    const lastAnswers = body.answers && dropHiddenAnswers(last, body.answers);
    const merged = this.cards.mergedAnswers(callId, lastAnswers)!;
    const nums = questionNumbers(card);
    const shown = new Set(visibleFields(card, merged).map((f) => f.id));
    const answers = Object.fromEntries(Object.entries(merged).filter(([id]) => shown.has(id)));
    const missing = card.fields.filter((f) => shown.has(f.id) && !f.optional && answers[f.id] === undefined);
    if (missing.length) throw new HttpError("invalid_request", `required question${missing.length === 1 ? "" : "s"} not answered: ${missing.map((f) => `Q${nums.get(f.id)} "${f.label}"`).join(", ")}`);
    const bad = validateAnswers(card, answers);
    if (bad) throw new HttpError("invalid_request", bad);
    const noteIds = [...new Set(body.note?.attachments ?? [])];
    if (body.note) {
      if (noteIds.length > 0 && !this.host.den) throw new HttpError("invalid_request", "this wolf has no den to read attachments from");
      const problem = this.cards.setNote(callId, { ...(body.note.text ? { text: body.note.text } : {}), ...(noteIds.length ? { attachments: noteIds } : {}) }, (id) => attachmentExists(this.host.den!, this.summary.id, id));
      if (problem && problem !== "not_found") throw new HttpError("invalid_request", problem);
    }
    // Synchronous from here to the claim: a concurrent submit finds the card claimed (409).
    // The on-screen page's answers are saved first, so the restore state (if the submit is withdrawn for good) has them.
    // NOTE: body.note replaces the stored note (setNote above) even if the claim is later released.
    if (lastAnswers) this.cards.savePage(callId, pending.pageIndex ?? 0, lastAnswers, pending.pageIndex ?? 0);
    const ready = this.cards.claimSubmit(callId, answers);
    if (!ready) throw new HttpError("not_found", `card ${callId}`);
    const before = this.turnStarts;
    if (this.answering++ === 0 && !this.running) this.answerStartedAt = new Date().toISOString();
    this.syncStatus();
    try {
      let r;
      try {
        r = await this.conv.submit({ input: this.answerInput([ready]), whenBusy: "steer", cardAnswers: cardAnswersOf([ready]) });
      } catch (e) {
        this.cards.release([callId]);
        if (e instanceof EngineBusyError) throw new HttpError("busy", `thread ${this.summary.id} is busy`);
        throw new HttpError("engine_error", e instanceof Error ? e.message : "submit failed");
      }
      this.cards.settle([callId]);
      this.trackQueued(r, { text: "", refs: [], cardAnswers: [ready] });
      this.syncCards(new Map([[callId, "answered" as CardClosed]]));
      if (r.disposition === "started") await this.waitFor(() => this.turnStarts > before);
      return { messageId: r.messageId, disposition: r.disposition };
    } finally {
      if (--this.answering === 0) this.answerStartedAt = null;
      this.syncStatus();
    }
  }

  /**
   * The model input for card answers: the answer text, plus the images bound to questions and the owner's note.
   * HOW IMAGES REACH THE MODEL: a card answer is delivered as a user message (the engine places it as a card-answer entry
   * whose content is this input), and a user message can carry image parts, exactly like a chat message with attachments
   * (`inlineAttachments`). So the images ride that same user turn, each preceded by a text label naming its question.
   */
  private answerInput(ready: readonly ReadyAnswer[]): SubmitOptions["input"] {
    const parts: Exclude<SubmitOptions["input"], string> = [];
    const sendable = ready.map((r) => {
      if (!r.card.paged || r.skipped) return r;
      const answers = { ...r.answers };
      for (const f of r.card.fields) {
        const a = answers[f.id];
        const ids = this.liveAttachments(attachmentIds(a));
        if (!a) continue;
        // Images that cannot be delivered are not mentioned in the text either; an answer that was only images says so.
        const { attachments: _drop, ...rest } = a as { attachments?: string[] };
        const gone = ids.length === 0 && isImageOnly(a as never);
        answers[f.id] = (ids.length ? { ...rest, attachments: ids } : gone ? { ...rest, imagesGone: true } : rest) as typeof a;
        if (ids.length) parts.push(...this.imagesFor(`Images the user attached to the answer of "${f.label}" (call ${r.callId}, question ${f.id}):`, ids));
      }
      const noteIds = this.liveAttachments(r.note?.attachments ?? []);
      if (noteIds.length) parts.push(...this.imagesFor(`Images the user attached to their note (call ${r.callId}):`, noteIds));
      const note = r.note && { ...(r.note.text ? { text: r.note.text } : {}), ...(noteIds.length ? { attachments: noteIds } : {}) };
      return { ...r, answers, ...(note ? { note } : {}) };
    });
    const text = answerText(sendable);
    return parts.length ? [{ type: "text", text }, ...parts] : text;
  }

  /** Of these upload ids, the ones still stored for this thread (a stat each). */
  private liveAttachments(ids: readonly string[]): string[] {
    const den = this.host.den;
    return den ? ids.filter((id) => attachmentExists(den, this.summary.id, id)) : [];
  }

  /** A text label plus the image parts of these (existing) uploads. */
  private imagesFor(label: string, ids: readonly string[]) {
    return this.host.den ? imageParts(this.host.den, this.summary.id, ids, label) : [];
  }

  /** The image parts of the questionnaires' drafted images, labelled per question (a plain message that supersedes them carries these). */
  private draftImages(cards: readonly PendingCard[], exclude: ReadonlySet<string>, budget: number) {
    const parts: ReturnType<ThreadRuntime["imagesFor"]> = [];
    const seen = new Set(exclude);
    let left = Math.max(0, budget);
    let omitted = 0;
    for (const p of cards) {
      if (!p.card.paged) continue;
      for (const f of p.card.fields) {
        const fresh = this.liveAttachments(attachmentIds(p.draft?.[f.id])).filter((id) => !seen.has(id));
        const ids = fresh.slice(0, left);
        omitted += fresh.length - ids.length;
        left -= ids.length;
        for (const id of ids) seen.add(id);
        if (ids.length) parts.push(...this.imagesFor(`Images the user attached to the unsubmitted answer of "${f.label}" (call ${p.callId}, question ${f.id}):`, ids));
      }
    }
    if (omitted > 0) parts.push({ type: "text" as const, text: `${omitted} more image${omitted === 1 ? " was" : "s were"} not sent (the limit is ${ATTACHMENT_MAX_PER_SUBMIT} per message).` });
    return parts;
  }

  /** "Answering Qn": hold typed text and/or uploaded images as that question's answer (not a chat message, supersedes nothing). */
  bindCardText(callId: string, qid: string, text: string, attachments: readonly string[] = [], multi?: { picked: string[]; others: string[] }, stepsKey?: string): void {
    // Same answers as save and note: 409 while the submit is in flight, 409 for other pages than the client saw.
    this.checkStepsKey(this.pagedCard(callId), stepsKey);
    const ids = [...new Set(attachments)];
    if (ids.length > 0 && !this.host.den) throw new HttpError("invalid_request", "this wolf has no den to read attachments from");
    // The tracker checks card, question and kind first, then calls `owned`: the id must be an upload of THIS thread (a stat).
    const problem = this.cards.bindText(callId, qid, text, ids, (id) => attachmentExists(this.host.den!, this.summary.id, id), multi);
    if (problem === "not_found") throw new HttpError("not_found", `card ${callId}`);
    if (problem) throw new HttpError("invalid_request", problem);
    this.announceHeld(callId);
  }

  /** Close every pending card as superseded, now (the later pi.user entry then finds nothing to dismiss). */
  supersedePending(): void {
    // Claimed cards (an answer is mid-submit) are not touched: they end answered/skipped, exactly once.
    const { ids, heldDiscarded } = this.cards.dismissUnclaimed();
    if (ids.length === 0) return;
    if (heldDiscarded.length > 0) {
      const turnId = this.running?.turnId;
      this.emit({ type: "error", ...(turnId ? { turnId } : {}), message: `Your message replaced ${ids.length === 1 ? "the pending question" : "the pending questions"}; the saved answer${heldDiscarded.length === 1 ? "" : "s"} (call ${heldDiscarded.join(", ")}) ${heldDiscarded.length === 1 ? "was" : "were"} discarded.` });
    }
    this.syncCards(new Map(ids.map((id): [string, CardClosed] => [id, "superseded"])));
    this.notify();
  }

  /**
   * Answer a pending card. The answer is a submission placed as a card-answer entry: the next turn starts with it as
   * input, and the history folds it onto the call that raised the card. While sibling cards of the turn still wait
   * the answer is held and the ack is `queued`.
   */
  async answerCard(callId: string, rawAnswers: CardAnswers): Promise<SubmitAck> {
    const pending = this.cards.get(callId);
    if (!pending) throw new HttpError("not_found", `card ${callId}`);
    if (pending.card.paged) throw new HttpError("invalid_request", `card ${callId} is a paged questionnaire: save its pages as drafts (saveCardPage) and send them once (submitCard)`);
    const bad = validateAnswers(pending.card, rawAnswers);
    if (bad) throw new HttpError("invalid_request", bad);
    const answers = dropHiddenAnswers(pending.card, rawAnswers);
    // Synchronous from here to the claim: a concurrent answer for the same call finds it claimed (404).
    return this.resolveCard(callId, this.cards.answer(callId, answers));
  }

  /** Skip a pending card: the agent is told, and a skip counts as the card's resolution among its siblings. */
  async skipCard(callId: string): Promise<SubmitAck> {
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
    // Sibling cards raised after this answer (same round, moments later) are not waited for: an answer given while the
    // turn still runs is steered at once, so a late sibling's answer arrives separately, each labelled with its card.
    const ids = ready.map((r) => r.callId);
    const before = this.turnStarts;
    if (this.answering++ === 0 && !this.running) this.answerStartedAt = new Date().toISOString();
    this.syncStatus();
    try {
      return await this.submitAnswers(ready, ids, before);
    } finally {
      if (--this.answering === 0) this.answerStartedAt = null;
      this.syncStatus();
    }
  }

  private async submitAnswers(ready: ReturnType<CardTracker["answer"]> & object, ids: string[], before: number): Promise<SubmitAck> {
    let r;
    try {
      // Mid-turn the answer is steered like a chat message typed then (the engine queues it for the turn's next
      // boundary or its end); idle it starts the turn. "reject" would only matter if a turn began between the two.
      r = await this.conv.submit({ input: this.answerInput(ready), whenBusy: "steer", cardAnswers: cardAnswersOf(ready) });
    } catch (e) {
      this.cards.release(ids);
      // Safety net: with whenBusy "steer" the engine never answers busy, so this should be unreachable.
      if (e instanceof EngineBusyError) throw new HttpError("busy", `thread ${this.summary.id} is busy`);
      throw new HttpError("engine_error", e instanceof Error ? e.message : "submit failed");
    }
    this.cards.settle(ids);
    this.trackQueued(r, { text: "", refs: [], cardAnswers: ready });
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
