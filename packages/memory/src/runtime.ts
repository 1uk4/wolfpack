/**
 * Agent runtime interface — what the memory system needs from its host agent.
 *
 * Pi implements this. Claude Code could implement this. Any future agent
 * runtime implements this. The memory system never imports Pi or any
 * agent-specific code — it only talks through this interface.
 *
 * The interface is deliberately minimal. A runtime provides:
 *   1. Conversation content (what happened)
 *   2. A way to make LLM calls (for observation/consolidation)
 *   3. A way to persist state (ledger)
 *   4. Lifecycle events (when things happen)
 */

/**
 * A chunk of conversation content to be observed.
 * The runtime produces these from whatever format it stores conversations in.
 */
export interface ConversationChunk {
  /** Unique ID for this chunk (for dedup/watermarking) */
  id: string;
  /** The conversation content as plain text */
  text: string;
  /** Estimated token count */
  tokenCount: number;
  /** When this chunk occurred */
  timestamp: string;
}

/**
 * An entry in the ledger — the append-only observation log.
 * The runtime persists these however it likes (Pi uses session entries,
 * a standalone process could use a JSON file).
 */
export interface LedgerEntry {
  type: "observations_recorded" | "observations_dropped" | "cost";
  timestamp: string;
  data: unknown;
}

/**
 * Lifecycle events the memory system can subscribe to.
 */
export type MemoryEvent =
  | "turn_end"         // A turn in the conversation ended
  | "session_start"    // A new session started
  | "session_end"      // The session is ending
  | "compact"          // Context is being compacted
  | "idle";            // Agent is idle (good time for background work)

export type MemoryEventHandler = () => void | Promise<void>;

/**
 * The runtime interface. Implement this for each agent platform.
 */
export interface AgentRuntime {
  /** Runtime name (for logging) */
  name: string;

  /**
   * Get conversation chunks since the last watermark.
   * The memory system calls this to get new content to observe.
   */
  getNewChunks(sinceId?: string): ConversationChunk[];

  /**
   * Append a ledger entry. The runtime decides where to persist it.
   * Pi: appendEntry to session. Standalone: write to JSON file.
   */
  appendLedger(entry: LedgerEntry): void;

  /**
   * Read all ledger entries (for fold/projection).
   */
  readLedger(): LedgerEntry[];

  /**
   * Subscribe to a lifecycle event.
   * Returns an unsubscribe function.
   */
  on(event: MemoryEvent, handler: MemoryEventHandler): () => void;

  /**
   * The working directory (project root).
   * Used to resolve .memory/ paths.
   */
  cwd: string;

  /**
   * Session ID (stable across resumes).
   */
  sessionId: string;

  /**
   * Optional: notify the user/agent about memory activity.
   * Pi: TUI toast. CLI: console.log. Can be a no-op.
   */
  notify?(message: string, level?: "info" | "warning" | "error"): void;
}
