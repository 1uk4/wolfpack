/**
 * Wire types are owned by @wolfpack/protocol; re-exported here so SDK
 * consumers keep a single import site. SDK-level types stay local.
 */
import type { Actor, ErrorCode, SubmitAck, ThreadDetail, ThreadEvent as ProtocolThreadEvent, ThreadSummary, WhenBusy, WolfSummary } from "@wolfpack/protocol";

export type {
  Actor,
  SubmitAck,
  ThreadDetail,
  ThreadMessage,
  ThreadSummary,
  WhenBusy,
  WolfSummary,
} from "@wolfpack/protocol";

/**
 * The event union as the SDK surfaces it: protocol events minus `snapshot`
 * (the in-process client never resends baselines) and with `actor` optional,
 * so consumers that build or ignore actor keep compiling. The mock always sets it.
 */
export type ThreadEvent = ProtocolThreadEvent extends infer E
  ? E extends { type: "snapshot" }
    ? never
    : E extends unknown
      ? Omit<E, "actor"> & { actor?: Actor }
      : never
  : never;
/** A snapshot baseline frame (see {@link WatchOptions.onSnapshot}). */
export type SnapshotEvent = Extract<ProtocolThreadEvent, { type: "snapshot" }>;
export type ThreadEventType = ThreadEvent["type"];

export type WolfStatus = WolfSummary["status"];
export type ThreadKind = ThreadSummary["kind"];

export interface SubmitOptions {
  /** What to do if a turn is already running. Default: "reject". */
  whenBusy?: WhenBusy;
}

export interface WatchOptions {
  /** Replay events with id > from, then continue live. Omit to replay the current/last turn from its start. */
  from?: number;
  /**
   * Snapshot fold. When the server cannot replay from `from` (stale cursor) it
   * sends a `snapshot` baseline instead. `watch()` never yields snapshots:
   * it hands the baseline to this callback (state as of `upToId`, plus any
   * partial in-flight turn) and treats `upToId` as the new cursor, so the
   * events that follow continue gap-free. Consumers should replace their local
   * thread state with `snapshot.thread` / `snapshot.inFlight`. HTTP client only;
   * the in-process mock never sends baselines.
   */
  onSnapshot?: (snapshot: SnapshotEvent) => void;
}

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

/** Any protocol error envelope that has no dedicated class (match by `code`, not HTTP status). */
export class ProtocolError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}
