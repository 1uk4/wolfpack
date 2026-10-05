/**
 * PiRuntime — implements AgentRuntime for Pi's extension API.
 *
 * This is the ONLY file that imports or depends on Pi-specific types.
 * Everything else in @wolfpack/memory is agent-agnostic.
 *
 * Bridges:
 *   - Pi's session entries → ConversationChunks
 *   - Pi's appendEntry → LedgerEntry persistence
 *   - Pi's session events → MemoryEvent subscriptions
 *   - Pi's TUI → notify()
 */
import type {
  AgentRuntime,
  ConversationChunk,
  LedgerEntry,
  MemoryEvent,
  MemoryEventHandler,
} from "@wolfpack/memory";

// Pi types — we use 'any' for the ExtensionAPI and ctx since we don't want
// a hard dependency on @earendil-works/pi-coding-agent at compile time.
// The extension entry point receives the real typed API at runtime.
type PiAPI = any;
type PiCtx = any;

/** Custom entry type for wolfpack ledger data in Pi's session */
const WP_LEDGER = "wp.memory.ledger";

/** Custom entry type for wolfpack observation data */
const WP_OBSERVATIONS = "wp.memory.observations";

/**
 * Serialize Pi session branch entries into text chunks.
 * Each chunk gets conversation content up to a token limit.
 */
function serializeBranchEntries(entries: any[]): Array<{ id: string; text: string; tokens: number }> {
  const chunks: Array<{ id: string; text: string; tokens: number }> = [];

  for (const entry of entries) {
    // Skip non-content entries (custom types, system messages)
    if (entry.type === "custom") continue;
    if (entry.type === "system") continue;

    let text = "";
    if (entry.type === "user" || entry.type === "assistant") {
      if (typeof entry.message === "string") {
        text = entry.message;
      } else if (entry.message?.content) {
        // Handle structured content (text blocks)
        if (typeof entry.message.content === "string") {
          text = entry.message.content;
        } else if (Array.isArray(entry.message.content)) {
          text = entry.message.content
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("\n");
        }
      }
    } else if (entry.type === "tool_use") {
      text = `[Tool call: ${entry.toolName}(${JSON.stringify(entry.input).slice(0, 500)})]`;
    } else if (entry.type === "tool_result") {
      const content = typeof entry.content === "string"
        ? entry.content.slice(0, 2000)
        : JSON.stringify(entry.content).slice(0, 2000);
      text = `[Tool result: ${content}]`;
    }

    if (text.length > 0) {
      const tokens = Math.ceil(text.length / 4); // rough estimate
      chunks.push({ id: entry.id, text: `[${entry.type}] ${text}`, tokens });
    }
  }

  return chunks;
}

/**
 * Create a PiRuntime from Pi's extension API and a session context.
 */
export function createPiRuntime(pi: PiAPI, ctx: PiCtx): PiRuntime {
  return new PiRuntime(pi, ctx);
}

export class PiRuntime implements AgentRuntime {
  readonly name = "pi";
  private pi: PiAPI;
  private ctx: PiCtx;
  private handlers = new Map<MemoryEvent, Set<MemoryEventHandler>>();
  private lastChunkId: string | undefined;

  constructor(pi: PiAPI, ctx: PiCtx) {
    this.pi = pi;
    this.ctx = ctx;
  }

  get cwd(): string {
    return this.ctx.cwd ?? process.cwd();
  }

  get sessionId(): string {
    return this.ctx.sessionId ?? "unknown";
  }

  /**
   * Get conversation chunks since the last watermark.
   * Reads from Pi's session branch (the live conversation).
   */
  getNewChunks(sinceId?: string): ConversationChunk[] {
    const branch = this.ctx.sessionManager?.getBranch?.() ?? [];
    const since = sinceId ?? this.lastChunkId;

    // Find the starting index
    let startIdx = 0;
    if (since) {
      const idx = branch.findIndex((e: any) => e.id === since);
      if (idx >= 0) startIdx = idx + 1;
    }

    const newEntries = branch.slice(startIdx);
    if (newEntries.length === 0) return [];

    const serialized = serializeBranchEntries(newEntries);
    if (serialized.length === 0) return [];

    // Group into chunks of ~5000 tokens
    const CHUNK_TOKEN_LIMIT = 5000;
    const chunks: ConversationChunk[] = [];
    let currentText = "";
    let currentTokens = 0;
    let chunkStartId = serialized[0].id;

    for (const entry of serialized) {
      if (currentTokens + entry.tokens > CHUNK_TOKEN_LIMIT && currentText.length > 0) {
        chunks.push({
          id: chunkStartId,
          text: currentText,
          tokenCount: currentTokens,
          timestamp: new Date().toISOString(),
        });
        currentText = "";
        currentTokens = 0;
        chunkStartId = entry.id;
      }
      currentText += (currentText ? "\n\n" : "") + entry.text;
      currentTokens += entry.tokens;
    }

    if (currentText.length > 0) {
      const lastEntry = serialized[serialized.length - 1];
      chunks.push({
        id: lastEntry.id,
        text: currentText,
        tokenCount: currentTokens,
        timestamp: new Date().toISOString(),
      });
    }

    // Update watermark
    if (serialized.length > 0) {
      this.lastChunkId = serialized[serialized.length - 1].id;
    }

    return chunks;
  }

  /**
   * Persist a ledger entry via Pi's appendEntry.
   */
  appendLedger(entry: LedgerEntry): void {
    this.pi.appendEntry(WP_LEDGER, entry);
  }

  /**
   * Read all ledger entries from Pi's session.
   */
  readLedger(): LedgerEntry[] {
    const entries = this.ctx.sessionManager?.getBranch?.() ?? [];
    return entries
      .filter((e: any) => e.type === "custom" && e.customType === WP_LEDGER)
      .map((e: any) => e.data as LedgerEntry);
  }

  /**
   * Subscribe to memory events. Returns an unsubscribe function.
   */
  on(event: MemoryEvent, handler: MemoryEventHandler): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
    return () => {
      this.handlers.get(event)?.delete(handler);
    };
  }

  /**
   * Emit an event to all registered handlers.
   */
  async emit(event: MemoryEvent): Promise<void> {
    const handlers = this.handlers.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      await handler();
    }
  }

  /**
   * Notify the user via Pi's TUI.
   */
  notify(message: string, level: "info" | "warning" | "error" = "info"): void {
    if (this.ctx.hasUI && this.ctx.ui?.notify) {
      this.ctx.ui.notify(`wolf: ${message}`, level);
    }
  }

  /**
   * Update the context after Pi events (e.g. new session start).
   */
  updateCtx(ctx: PiCtx): void {
    this.ctx = ctx;
  }
}
