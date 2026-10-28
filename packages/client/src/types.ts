/**
 * Wire types are owned by @wolfpack/protocol; re-exported here so SDK
 * consumers keep a single import site. SDK-level types stay local.
 */
import type { Actor, BindThreadResponse, CreateThreadBody, LedgerEntry, CardAnswers, PendingCard, Attachment, AttachmentRef, ConsolidateResponse, ErrorCode, KbEntryDetail, KbGraph, MemoryEvent, MemoryStatus, MemoryObservations, WolfEvent, MemoryTopic, PromoteResponse, SubmitAck, ThreadDetail, ThreadEvent as ProtocolThreadEvent, ThreadSummary, WhenBusy, WolfSummary, WorkRecordResponse, WorkspaceStatus, KbPipelineResponse } from "@wolfpack/protocol";

export type {
  Actor,
  BindThreadResponse,
  Attachment,
  LedgerEntry,
  LedgerKind,
  LedgerParty,
  SubagentState,
  AttachmentRef,
  SubmitAck,
  ThreadDetail,
  ThreadMessage,
  ThreadObject,
  ThreadToolCall,
  ThreadSummary,
  ThreadWorkspace,
  WhenBusy,
  WolfSummary,
  WorkspaceStatus,
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

export type { CreateThreadBody } from "@wolfpack/protocol";
export type { WolfEvent, WolfEventType, CardOutcome } from "@wolfpack/protocol";
export type { Card, CardAnswers, CardClosed, CardField, CardFieldAnswer, CardFieldKind, ConfirmFieldAnswer, MultiFieldAnswer, TextFieldAnswer, CardOption, PendingCard, ThreadStatus } from "@wolfpack/protocol";
export type { ConsolidateResponse, PromoteResponse, MemoryEvent, MemoryEventType, MemoryTarget, MemoryStatus, MemoryTopic, MemoryTopicRef, MemoryObservation, MemoryObservations, BoundWork, MemoryState, MemoryPoolStatus, LastPromote, WorkRecordResponse, KbPipelineResponse, PipelineOutcome, PipelineLane, PipelineReceipt, PipelineParked, PipelineCurrent, PipelineLastSweep, SweepOutcome } from "@wolfpack/protocol";
export type { KbGraph, KbGraphNode, KbGraphEdge, KbEntryDetail, KbNodeKind, KbEdgeKind } from "@wolfpack/protocol";

export type WolfStatus = WolfSummary["status"];
export type ThreadKind = ThreadSummary["kind"];

export interface SubmitOptions {
  /** What to do if a turn is already running. Default: "reject". */
  whenBusy?: WhenBusy;
  /** Uploaded attachments (see `uploadAttachment`) to send with the input; the input may then be empty. */
  attachments?: AttachmentRef[];
}

export interface UploadOptions {
  /** MIME type of the bytes (the wolf decides what it accepts). */
  mimeType: string;
  /** Original file name, kept for display. */
  name?: string;
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
  /** The subagent threads a thread spawned (any state), oldest first. Rejects NotFoundError for an unknown thread. Optional: the mock has no subagents. */
  listChildren?(threadId: string): Promise<ThreadSummary[]>;
  /** A subagent thread's ledger (brief, steers, questions, owner messages, results), oldest first. Rejects NotFoundError for an unknown thread or one that is not a subagent. Optional like listChildren. */
  getLedger?(threadId: string): Promise<LedgerEntry[]>;
  // ---- header git tree ----
  /** Live git state of the thread's workspace (header popover). Rejects NotFoundError for an unknown thread or one without a git workspace. Optional: the mock has no git. */
  getWorkspaceStatus?(threadId: string): Promise<WorkspaceStatus>;
  // ---- /header git tree ----
  /**
   * Open a thread: `{kind:"home"}`, or `{kind:"feature", workItemId}` for a thread bound to that feature. Idempotent:
   * the same feature returns its existing thread. Optional: not every client has it.
   */
  createThread?(wolf: string, body: CreateThreadBody): Promise<ThreadSummary>;
  /** Acknowledges and returns; does NOT wait for the turn. Rejects with BusyError when whenBusy=reject and a turn is running. */
  submit(threadId: string, input: string, opts?: SubmitOptions): Promise<SubmitAck>;
  /** Stores one file on the thread's wolf and returns its reference for `submit`. Rejects with ProtocolError `invalid_request` for a type or size the wolf refuses. */
  uploadAttachment(threadId: string, data: Uint8Array | Blob, opts: UploadOptions): Promise<Attachment>;
  /** Fetches an uploaded attachment's bytes and stored mime type. Rejects with NotFoundError for an id the thread does not have. */
  getAttachment(threadId: string, attachmentId: string): Promise<{ bytes: Uint8Array; mimeType: string }>;
  /**
   * Answer a pending card (`callId` = the tool call that raised it, see `PendingCard`). Resolves that call with the
   * answer and starts the next turn; the ack is that turn's, or disposition `queued` while sibling cards still wait.
   * Rejects NotFoundError for an unknown / already-answered card, BusyError while a turn runs. Optional: the mock has no cards.
   */
  answerCard?(threadId: string, callId: string, answers: CardAnswers): Promise<SubmitAck>;
  /** Skip a pending card without answering: the agent is told, siblings count it as resolved. Errors as `answerCard`. Optional like it. */
  skipCard?(threadId: string, callId: string): Promise<SubmitAck>;
  // --- feature progress: bind ---
  /**
   * Bind the thread's conversation to a work item (task, issue or spike). Rejects ProtocolError `invalid_request` (not
   * bindable, another feature's, held by another conversation), `thread_closed`, NotFoundError. Optional: the mock accepts any id.
   */
  bindThread?(threadId: string, workItemId: string): Promise<BindThreadResponse>;
  // --- end feature progress ---
  /** Cards waiting for the operator on this wolf (the needs-you list). Optional like answerCard. */
  listCards?(wolf: string): Promise<PendingCard[]>;
  /** Ends the running turn; the event stream finishes with turn-end (reason "aborted"). */
  abort(threadId: string): Promise<void>;
  /** Replays from `from`, then continues live until turn-end (inclusive). */
  watch(threadId: string, opts?: WatchOptions): AsyncIterable<ThreadEvent>;
  /**
   * Live MemoryEvents of a wolf (its event stream); unknown event types are skipped. Never ends on its own: stop with
   * `signal`. Optional: not every client (e.g. the mock) has a wolf stream.
   */
  watchMemory?(wolf: string, opts?: { signal?: AbortSignal }): AsyncIterable<MemoryEvent>;
  /**
   * Live status/card changes of a wolf (thread-status, card-pending, card-settled; `resync` = refetch). Starts with a
   * baseline of the current state, resumes across reconnects. Never ends on its own: stop with `signal`. Optional like watchMemory.
   */
  watchActivity?(wolf: string, opts?: { from?: string; signal?: AbortSignal; idleMs?: number }): AsyncIterable<WolfEvent>;
  /**
   * Fold the wolf's observation pool into session topics; resolves with counts and topic ids. Rejects with a
   * ProtocolError `memory_unavailable` when the wolf's memory is inert or not loaded. Optional like watchMemory.
   */
  consolidateMemory?(wolf: string): Promise<ConsolidateResponse>;
  /**
   * Start promote as a background job; resolves at once with `{jobId, status}`. `status` is `"already_running"` (with
   * the running job's id) instead of rejecting when one is in flight. The outcome arrives as promote_finished /
   * promote_failed MemoryEvents with that jobId (watchMemory). Rejects with ProtocolError `memory_unavailable` or
   * `promote_unavailable` (no KB roots). Optional like watchMemory.
   */
  promoteMemory?(wolf: string): Promise<PromoteResponse>;
  /**
   * Read-only memory status of a wolf (`thread`: report that thread's bound work item): state with reason, pool vs thresholds, session/den topic lists, last promote.
   * Resolves (does not reject) when memory is inert or off: that is the state. Optional like watchMemory.
   */
  getMemoryStatus?(wolf: string, opts?: { thread?: string }): Promise<MemoryStatus>;
  /** One den or session topic with its body (`scope` picks the store; default den, then session). Rejects NotFoundError for an unknown topic. */
  /** The wolf's current observation pool, newest first (`limit`: keep the newest n). Rejects with `memory_unavailable` when memory is inert or off. Optional like watchMemory. */
  getMemoryObservations?(wolf: string, opts?: { limit?: number }): Promise<MemoryObservations>;
  getMemoryTopic?(wolf: string, topicId: string, opts?: { scope?: "den" | "session" }): Promise<MemoryTopic>;
  /** The Record of a work item, via the wolf's Work API client. Rejects NotFoundError for an unknown item. */
  getWorkRecord?(wolf: string, workId: string): Promise<WorkRecordResponse>;
  /** Dewey's pipeline view. Librarian only: other wolves reject (kb_unavailable). */
  getKbPipeline?(wolf: string): Promise<KbPipelineResponse>;
  /** The KB graph (librarian wolf only; rejects ProtocolError `kb_unavailable` elsewhere, NotFoundError for an unknown domain). Layers default off. */
  getKbGraph?(wolf: string, opts?: { domain?: string; archivedWork?: boolean; denTopics?: boolean }): Promise<KbGraph>;
  /** One KB entry with its body, wikilinks and backlinks (librarian only). Rejects NotFoundError for an unknown entry. */
  getKbEntry?(wolf: string, id: string): Promise<KbEntryDetail>;
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
