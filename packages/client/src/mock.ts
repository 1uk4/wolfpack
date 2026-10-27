import { FIXTURE_SCRIPT, FIXTURE_THREAD, FIXTURE_WOLF, type ScriptStep } from "./fixture.js";
import { ATTACHMENT_IMAGE_TYPES, ATTACHMENT_MAX_BYTES } from "@wolfpack/protocol";
import {
  BusyError,
  NotFoundError,
  ProtocolError,
  type Attachment,
  type AttachmentRef,
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

type Distribute<T> = T extends unknown ? Omit<T, "id" | "threadId" | "at" | "actor"> : never;
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
    return [...this.threads.values()].map((t) => ({ ...t.summary }));
  }

  async getThread(threadId: string): Promise<ThreadDetail> {
    const t = this.get(threadId);
    return {
      ...t.summary,
      messages: t.messages.map((m) => ({ ...m })),
      busy: t.running !== null,
      lastEventId: t.seq,
    };
  }

  async submit(threadId: string, input: string, opts: SubmitOptions = {}): Promise<SubmitAck> {
    const t = this.get(threadId);
    const whenBusy = opts.whenBusy ?? "reject";
    const attachments = opts.attachments ?? [];
    for (const a of attachments) if (!this.uploads.some((u) => u.id === a.id && u.threadId === threadId)) throw new ProtocolError("invalid_request", `unknown attachment ${a.id}`, false);
    this.submits.push({ threadId, input, attachments });
    if (!t.running) {
      const messageId = this.addUserMessage(t, input);
      this.startTurn(t);
      return { messageId, disposition: "started" };
    }
    if (whenBusy === "reject") throw new BusyError(threadId);
    const messageId = this.addUserMessage(t, input);
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
    return att;
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

  private get(threadId: string): ThreadState {
    const t = this.threads.get(threadId);
    if (!t) throw new NotFoundError(`thread ${threadId}`);
    return t;
  }

  private addUserMessage(t: ThreadState, text: string): string {
    const id = `msg-${++this.counter}`;
    t.messages.push({ id, role: "user", text, at: new Date().toISOString() });
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
