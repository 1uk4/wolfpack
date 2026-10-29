import { FIXTURE_SCRIPT, FIXTURE_THREAD, FIXTURE_WOLF, type ScriptStep } from "./fixture.js";
import { pageRange, ATTACHMENT_IMAGE_TYPES, ATTACHMENT_MAX_BYTES, DEFAULT_THREAD_SETTINGS, type ThreadSettings, type ThreadSettingsPatch, type ThreadSettingsResponse, type ThreadContext } from "@wolfpack/protocol";
import {
  BusyError,
  NotFoundError,
  ProtocolError,
  type Attachment,
  type BindThreadResponse,
  type AttachmentRef,
  type Card,
  type CardAnswers,
  type CreateThreadBody,
  type WolfEvent,
  type PendingCard,
  type ConsoleClient,
  type SubmitAck,
  type SubmitOptions,
  type ThreadDetail,
  type ThreadEvent,
  type ThreadMessage,
  type ThreadSummary,
  type UploadOptions,
  type WatchOptions,
  type WolfSummary,
} from "./types.js";

export interface MockOptions {
  /** Delay between scripted events in ms. Default 10. */
  delayMs?: number;
  script?: ScriptStep[];
}

type Distribute<T, K extends string = "id" | "threadId" | "at" | "actor"> = T extends unknown ? Omit<T, K> : never;
type EventInput = Distribute<ThreadEvent>;

interface ThreadState {
  summary: ThreadSummary;
  messages: ThreadMessage[];
  events: ThreadEvent[];
  running: { turnId: string; abort: AbortController } | null;
  followUps: string[];
  waiters: Set<() => void>;
  seq: number;
}

export class MockConsoleClient implements ConsoleClient {
  private readonly threads = new Map<string, ThreadState>();
  private readonly delayMs: number;
  private readonly script: ScriptStep[];
  private counter = 0;
  /** Attachments uploaded so far (bytes dropped), and the submits that referenced them: for tests. */
  readonly uploads: (Attachment & { threadId: string })[] = [];
  private readonly uploadBytes = new Map<string, Uint8Array>();
  /** Card answers received, for tests. */
  readonly cardAnswers: { threadId: string; callId: string; answers: CardAnswers }[] = [];
  readonly cardSkips: { threadId: string; callId: string }[] = [];
  /** Cards raised through {@link raiseCard} and not yet answered (the scripted turns raise none themselves). */
  private readonly pendingCards: PendingCard[] = [];
  private readonly activitySubs = new Set<(ev: WolfEvent) => void>();
  private activitySeq = 0;
  readonly submits: { threadId: string; input: string; attachments: AttachmentRef[] }[] = [];

  constructor(opts: MockOptions = {}) {
    this.delayMs = opts.delayMs ?? 10;
    this.script = opts.script ?? FIXTURE_SCRIPT;
    this.threads.set(FIXTURE_THREAD.id, {
      summary: FIXTURE_THREAD,
      messages: [],
      events: [],
      running: null,
      followUps: [],
      waiters: new Set(),
      seq: 0,
    });
  }

  async listWolves(): Promise<WolfSummary[]> {
    return [{ ...FIXTURE_WOLF }];
  }

  async listThreads(wolf: string): Promise<ThreadSummary[]> {
    if (wolf !== FIXTURE_WOLF.id) throw new NotFoundError(`wolf ${wolf}`);
    return [...this.threads.values()].map((t) => ({ ...t.summary, status: this.statusOf(t) }));
  }

  /** Feature threads are created on demand (one per work item); `home` returns the fixture thread. */
  async createThread(wolf: string, body: CreateThreadBody): Promise<ThreadSummary> {
    if (wolf !== FIXTURE_WOLF.id) throw new NotFoundError(`wolf ${wolf}`);
    if (body.kind === "home") return { ...FIXTURE_THREAD };
    const id = `${FIXTURE_WOLF.id}/feature-${body.workItemId}`;
    const have = this.threads.get(id);
    if (have) return { ...have.summary, status: this.statusOf(have) };
    const summary: ThreadSummary = { id, wolf, kind: "feature", title: body.workItemId, boundWorkItem: body.workItemId };
    this.threads.set(id, { summary, messages: [], events: [], running: null, followUps: [], waiters: new Set(), seq: 0 });
    return { ...summary, status: "idle" };
  }

  private statusOf(t: ThreadState): NonNullable<ThreadSummary["status"]> {
    return t.running ? "busy" : this.pendingCards.some((p) => p.threadId === t.summary.id) ? "needs-you" : "idle";
  }

  /** Test seam: the wolf asks the operator `card` on `threadId`. The thread turns needs-you and activity watchers hear it. */
  raiseCard(threadId: string, card: Card, callId = `call-${++this.counter}`, raisedAt = new Date().toISOString()): PendingCard {
    const t = this.get(threadId);
    const pending: PendingCard = { callId, threadId, card, raisedAt };
    this.pendingCards.push(pending);
    this.emitActivity({ type: "card-pending", card: pending });
    this.emitActivity({ type: "thread-status", threadId, status: this.statusOf(t) });
    return pending;
  }

  private emitActivity(draft: Distribute<WolfEvent, "id" | "wolf" | "at">): void {
    const ev = { ...draft, id: ++this.activitySeq, wolf: FIXTURE_WOLF.id, at: new Date().toISOString() } as WolfEvent;
    for (const s of [...this.activitySubs]) s(ev);
  }

  async *watchActivity(wolf: string, opts: { signal?: AbortSignal } = {}): AsyncIterable<WolfEvent> {
    if (wolf !== FIXTURE_WOLF.id) throw new NotFoundError(`wolf ${wolf}`);
    const queue: WolfEvent[] = [];
    let wake: (() => void) | undefined;
    const sub = (ev: WolfEvent) => {
      queue.push(ev);
      wake?.();
    };
    this.activitySubs.add(sub);
    const onAbort = () => wake?.();
    opts.signal?.addEventListener("abort", onAbort);
    try {
      while (!opts.signal?.aborted) {
        const next = queue.shift();
        if (next) yield next;
        else await new Promise<void>((r) => (wake = r));
      }
    } finally {
      this.activitySubs.delete(sub);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  async getThread(threadId: string, opts: { limit?: number; before?: string } = {}): Promise<ThreadDetail> {
    const t = this.get(threadId);
    const pending = this.pendingCards.filter((p) => p.threadId === threadId);
    const page = pageRange(t.messages, { ...opts, requiredCallIds: pending.map((p) => p.callId) });
    return {
      ...t.summary,
      status: this.statusOf(t),
      messages: t.messages.slice(page.start, page.end).map((m) => ({ ...m })),
      ...(opts.limit !== undefined ? { hasMore: page.hasMore, ...(page.cursor ? { cursor: page.cursor } : {}) } : {}),
      busy: t.running !== null,
      lastEventId: t.seq,
      ...(this.pendingCards.some((p) => p.threadId === threadId) ? { pendingCards: this.pendingCards.filter((p) => p.threadId === threadId) } : {}),
    };
  }

  async submit(threadId: string, input: string, opts: SubmitOptions = {}): Promise<SubmitAck> {
    const t = this.get(threadId);
    if (t.summary.closed) throw new ProtocolError("thread_closed", t.summary.closedReason ?? "thread is closed", false);
    const whenBusy = opts.whenBusy ?? "reject";
    const attachments = opts.attachments ?? [];
    for (const a of attachments) if (!this.uploads.some((u) => u.id === a.id && u.threadId === threadId)) throw new ProtocolError("invalid_request", `unknown attachment ${a.id}`, false);
    this.submits.push({ threadId, input, attachments });
    const atts = attachments.map((a) => {
      const { threadId: _t, ...att } = this.uploads.find((u) => u.id === a.id && u.threadId === threadId)!;
      return att;
    });
    if (!t.running) {
      const messageId = this.addUserMessage(t, input, atts);
      this.startTurn(t);
      return { messageId, disposition: "started" };
    }
    if (whenBusy === "reject") throw new BusyError(threadId);
    const messageId = this.addUserMessage(t, input, atts);
    if (whenBusy === "followUp") {
      t.followUps.push(input);
      return { messageId, disposition: "queued" };
    }
    return { messageId, disposition: "steered" };
  }

  async uploadAttachment(threadId: string, data: Uint8Array | Blob, opts: UploadOptions): Promise<Attachment> {
    this.get(threadId);
    const size = data instanceof Blob ? data.size : data.byteLength;
    if (!(ATTACHMENT_IMAGE_TYPES as readonly string[]).includes(opts.mimeType)) throw new ProtocolError("invalid_request", `unsupported attachment type ${opts.mimeType}`, false);
    if (size > ATTACHMENT_MAX_BYTES) throw new ProtocolError("invalid_request", "attachment too large", false);
    const id = `att-${++this.counter}`;
    const att = { id, name: opts.name ?? id, mimeType: opts.mimeType, size };
    this.uploads.push({ ...att, threadId });
    this.uploadBytes.set(`${threadId}\n${id}`, data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data));
    return att;
  }

  async getAttachment(threadId: string, attachmentId: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    this.get(threadId);
    const up = this.uploads.find((u) => u.threadId === threadId && u.id === attachmentId);
    const bytes = this.uploadBytes.get(`${threadId}\n${attachmentId}`);
    if (!up || !bytes) throw new NotFoundError(`attachment ${attachmentId}`);
    return { bytes, mimeType: up.mimeType };
  }

  /** Answers a card raised through `raiseCard` (no next turn is started); any other card is unknown. */
  async answerCard(threadId: string, callId: string, answers: CardAnswers): Promise<SubmitAck> {
    const t = this.get(threadId);
    const at = this.pendingCards.findIndex((p) => p.threadId === threadId && p.callId === callId);
    if (at < 0) throw new NotFoundError(`card ${callId}`);
    this.cardAnswers.push({ threadId, callId, answers });
    this.pendingCards.splice(at, 1);
    this.emitActivity({ type: "card-settled", threadId, callId, outcome: "answered" });
    this.emitActivity({ type: "thread-status", threadId, status: this.statusOf(t) });
    return { messageId: `card-${callId}`, disposition: "started" };
  }

  /** Skips a card raised through `raiseCard` (no next turn is started); any other card is unknown. */
  async skipCard(threadId: string, callId: string): Promise<SubmitAck> {
    const t = this.get(threadId);
    const at = this.pendingCards.findIndex((p) => p.threadId === threadId && p.callId === callId);
    if (at < 0) throw new NotFoundError(`card ${callId}`);
    this.cardSkips.push({ threadId, callId });
    this.pendingCards.splice(at, 1);
    this.emitActivity({ type: "card-settled", threadId, callId, outcome: "dismissed", closed: "skipped" });
    this.emitActivity({ type: "thread-status", threadId, status: this.statusOf(t) });
    return { messageId: `card-${callId}`, disposition: "started" };
  }

  readonly settings = new Map<string, ThreadSettings>();
  async getThreadSettings(threadId: string): Promise<ThreadSettingsResponse> {
    this.get(threadId);
    return { ...DEFAULT_THREAD_SETTINGS, ...this.settings.get(threadId) };
  }
  readonly compactions = new Map<string, { count: number; lastAt?: string }>();
  async getThreadContext(threadId: string): Promise<ThreadContext> {
    this.get(threadId);
    return { tokens: 12_000, window: 1_000_000, startAt: 200_000, waitAt: 983_616, compactions: this.compactions.get(threadId) ?? { count: 0 }, compacting: false };
  }
  async compactThread(threadId: string, _instructions?: string): Promise<void> {
    this.get(threadId);
    const c = this.compactions.get(threadId) ?? { count: 0 };
    this.compactions.set(threadId, { count: c.count + 1, lastAt: new Date().toISOString() });
  }
  async putThreadSettings(threadId: string, patch: ThreadSettingsPatch): Promise<ThreadSettingsResponse> {
    this.get(threadId);
    const next = { ...DEFAULT_THREAD_SETTINGS, ...this.settings.get(threadId), ...patch };
    this.settings.set(threadId, next);
    return next;
  }

  // --- feature progress: bind ---
  readonly binds: Array<{ threadId: string; workItemId: string }> = [];
  async bindThread(threadId: string, workItemId: string): Promise<BindThreadResponse> {
    this.get(threadId);
    this.binds.push({ threadId, workItemId });
    return { threadId, workItemId };
  }
  // --- end feature progress ---

  async listCards(wolf: string): Promise<PendingCard[]> {
    if (wolf !== FIXTURE_WOLF.id) throw new NotFoundError(`wolf ${wolf}`);
    return this.pendingCards.map((p) => ({ ...p }));
  }

  async abort(threadId: string): Promise<void> {
    const t = this.get(threadId);
    t.followUps = [];
    t.running?.abort.abort();
  }

  async *watch(threadId: string, opts: WatchOptions = {}): AsyncIterable<ThreadEvent> {
    const t = this.get(threadId);
    let cursor: number;
    if (opts.from !== undefined) {
      cursor = t.events.findIndex((e) => e.id > opts.from!);
      if (cursor < 0) cursor = t.events.length;
    } else {
      // Default: start of the current (or most recent) turn.
      cursor = 0;
      for (let i = t.events.length - 1; i >= 0; i--) {
        if (t.events[i].type === "turn-start") {
          cursor = i;
          break;
        }
      }
    }
    for (;;) {
      while (cursor < t.events.length) {
        const ev = t.events[cursor++];
        yield { ...ev } as ThreadEvent;
        if (ev.type === "turn-end") return;
      }
      if (!t.running) return;
      await new Promise<void>((resolve) => {
        const wake = () => {
          t.waiters.delete(wake);
          resolve();
        };
        t.waiters.add(wake);
      });
    }
  }

  // --- internals ---

  /** Test hook: mark a thread read-only history (its feature graduated); submits then reject with `thread_closed`. */
  closeThread(threadId: string, reason = "This feature has graduated; its thread is read-only history. Start a new feature or use home."): void {
    const t = this.get(threadId);
    t.summary = { ...t.summary, closed: true, closedReason: reason };
  }

  private get(threadId: string): ThreadState {
    const t = this.threads.get(threadId);
    if (!t) throw new NotFoundError(`thread ${threadId}`);
    return t;
  }

  private addUserMessage(t: ThreadState, text: string, atts: Attachment[] = []): string {
    const id = `msg-${++this.counter}`;
    t.messages.push({ id, role: "user", text, at: new Date().toISOString(), ...(atts.length ? { attachments: atts } : {}) });
    return id;
  }

  private emit(t: ThreadState, ev: EventInput): void {
    const full = {
      ...ev,
      id: ++t.seq,
      threadId: t.summary.id,
      at: new Date().toISOString(),
      actor: { id: t.summary.wolf, kind: "wolf" },
    } as ThreadEvent;
    t.events.push(full);
    for (const w of [...t.waiters]) w();
  }

  private startTurn(t: ThreadState): void {
    const turnId = `turn-${++this.counter}`;
    const abort = new AbortController();
    t.running = { turnId, abort };
    // Emit turn-start synchronously so a watch() right after submit() sees it.
    this.emit(t, { type: "turn-start", turnId });
    void this.runScript(t, turnId, abort.signal);
  }

  private async runScript(t: ThreadState, turnId: string, signal: AbortSignal): Promise<void> {
    let assistantText = "";
    let reason: "complete" | "aborted" = "complete";
    try {
      let n = 0;
      for (const step of this.script) {
        if (!(await this.pause(signal))) throw new AbortSignalError();
        if (step.kind === "thinking") {
          this.emit(t, { type: "thinking-delta", turnId, text: step.text });
        } else if (step.kind === "text") {
          assistantText += step.text;
          this.emit(t, { type: "text-delta", turnId, text: step.text });
        } else {
          const callId = `call-${turnId}-${++n}`;
          this.emit(t, { type: "tool-start", turnId, callId, name: step.name, args: step.args });
          for (const output of step.updates) {
            if (!(await this.pause(signal))) throw new AbortSignalError();
            this.emit(t, { type: "tool-update", turnId, callId, output });
          }
          if (!(await this.pause(signal))) throw new AbortSignalError();
          this.emit(t, { type: "tool-end", turnId, callId, result: step.result, isError: false });
        }
      }
    } catch (e) {
      if (!(e instanceof AbortSignalError)) throw e;
      reason = "aborted";
    }
    if (assistantText) {
      t.messages.push({ id: `msg-${++this.counter}`, role: "assistant", text: assistantText, at: new Date().toISOString() });
    }
    t.running = null;
    this.emit(t, { type: "turn-end", turnId, reason });
    const next = t.followUps.shift();
    if (next !== undefined && reason === "complete") this.startTurn(t);
  }

  /** Resolves true after the delay, false if aborted. */
  private pause(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve(true);
      }, this.delayMs);
      const onAbort = () => {
        clearTimeout(timer);
        resolve(false);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

class AbortSignalError extends Error {}
