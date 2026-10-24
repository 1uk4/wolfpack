/**
 * Provisional console client types. A later protocol package will finalize the
 * wire format; these stay self-contained on purpose.
 */

export type WolfStatus = "online" | "offline" | "busy";

export interface WolfSummary {
  id: string;
  name: string;
  host: string;
  status: WolfStatus;
}

export type ThreadKind = "home" | "feature" | "subagent" | "process";

export interface ThreadSummary {
  id: string;
  wolf: string;
  kind: ThreadKind;
  title: string;
  boundWorkItem?: string;
}

export interface ThreadMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** ISO timestamp. */
  at: string;
}

export interface ThreadDetail extends ThreadSummary {
  messages: ThreadMessage[];
  /** True while a turn is streaming. */
  busy: boolean;
  /** Id of the latest event emitted on this thread (0 if none). */
  lastEventId: number;
}

export type WhenBusy = "steer" | "followUp" | "reject";

export interface SubmitOptions {
  /** What to do if a turn is already running. Default: "reject". */
  whenBusy?: WhenBusy;
}

export interface SubmitAck {
  /** Id of the user message created by this submit. */
  messageId: string;
  /** How the input was handled. */
  disposition: "started" | "steered" | "queued";
}

export interface WatchOptions {
  /** Replay events with id > from, then continue live. Omit to replay the current/last turn from its start. */
  from?: number;
}

interface EventBase {
  /** Monotonically increasing per thread; usable as SSE Last-Event-ID. */
  id: number;
  threadId: string;
  /** ISO timestamp. */
  at: string;
}

export type ThreadEvent =
  | (EventBase & { type: "turn-start"; turnId: string })
  | (EventBase & { type: "text-delta"; turnId: string; text: string })
  | (EventBase & { type: "thinking-delta"; turnId: string; text: string })
  | (EventBase & { type: "tool-start"; turnId: string; callId: string; name: string; args: unknown })
  | (EventBase & { type: "tool-update"; turnId: string; callId: string; output: string })
  | (EventBase & { type: "tool-end"; turnId: string; callId: string; result: string; isError: boolean })
  | (EventBase & { type: "turn-end"; turnId: string; reason: "complete" | "aborted" | "error" })
  | (EventBase & { type: "error"; turnId?: string; message: string });

export type ThreadEventType = ThreadEvent["type"];

export interface ConsoleClient {
  listWolves(): Promise<WolfSummary[]>;
  listThreads(wolf: string): Promise<ThreadSummary[]>;
  getThread(threadId: string): Promise<ThreadDetail>;
  /** Acknowledges and returns; does NOT wait for the turn. Rejects with BusyError when whenBusy=reject and a turn is running. */
  submit(threadId: string, input: string, opts?: SubmitOptions): Promise<SubmitAck>;
  /** Ends the running turn; the event stream finishes with turn-end (reason "aborted"). */
  abort(threadId: string): Promise<void>;
  /** Replays from `from`, then continues live until turn-end (inclusive). */
  watch(threadId: string, opts?: WatchOptions): AsyncIterable<ThreadEvent>;
}

export class BusyError extends Error {
  constructor(public readonly threadId: string) {
    super(`thread ${threadId} is busy`);
    this.name = "BusyError";
  }
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`not found: ${what}`);
    this.name = "NotFoundError";
  }
}
