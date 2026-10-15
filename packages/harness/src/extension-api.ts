/**
 * Unified Extension API for Wolfpack.
 * 
 * Extensions implement this interface once, and the harness adapts it
 * to the appropriate runtime (pi or pi-durable).
 * 
 * This provides:
 * - Single source of truth per extension
 * - Runtime-agnostic extension development
 * - Consistent tooling and bundling
 */
import { Type } from "@earendil-works/pi-ai";

// Re-export Type for extension authors
export { Type };

// TypeBox types (used by pi-ai)
type TObject = ReturnType<typeof Type.Object>;

// ─── Tool Types ────────────────────────────────────────────────────────────

export interface ToolContext {
  /** Current working directory */
  cwd: string;
  /** Wolf den path */
  wolfDen: string;
  /** Wolf name */
  wolfName: string;
  /** Conversation ID (1 = root, >1 = subagent) */
  conversationId: number;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  parameters: TObject;
  execute: (args: unknown, context: ToolContext) => Promise<ToolResult>;
}

// ─── Section Types ─────────────────────────────────────────────────────────

export interface Section {
  /** Section identifier (used in system prompt) */
  name: string;
  /** Render function - return undefined to omit section */
  render: (context: SectionContext) => string | undefined;
}

export interface SectionContext {
  wolfDen: string;
  wolfName: string;
  conversationId: number;
}

// ─── Hook Types ────────────────────────────────────────────────────────────

export interface AssistantMessage {
  content: Array<
    | { type: "text"; text: string }
    | { type: "toolCall"; name: string; arguments: unknown }
    | { type: "thinking"; thinking: string }
  >;
}

export interface HookContext {
  wolfDen: string;
  wolfName: string;
  conversationId: number;
}

export interface Hooks {
  /** Called after each assistant response */
  afterResponse?: (message: AssistantMessage, context: HookContext) => void | Promise<void>;
}

// ─── Shared State Types ────────────────────────────────────────────────────

/** Button configuration for Telegram inline keyboards */
export interface TelegramButton {
  text: string;
  callbackData: string;
}

/** Reply keyboard configuration */
export interface ReplyKeyboard {
  keyboard: string[][];
  oneTime?: boolean;
  resize?: boolean;
  placeholder?: string;
}

/** Attachment with path and filename */
export interface TelegramAttachment {
  path: string;
  fileName: string;
}

/** Shared state for telegram extension/client coordination */
export interface TelegramSharedState {
  /** Queued inline buttons by conversation ID */
  queuedButtons: Map<string, TelegramButton[][]>;
  /** Queued reply keyboards by conversation ID */
  queuedReplyKeyboards: Map<string, ReplyKeyboard>;
  /** Queued reactions by conversation ID */
  queuedReactions: Map<string, string>;
  /** Queued file attachments by conversation ID */
  queuedAttachments: Map<string, TelegramAttachment[]>;
  /** Valid reaction emojis */
  validReactions: Set<string>;
  /** Direct Bot API access for pin/edit/unpin. Injected by harness after bot creation. */
  botApi?: {
    pinChatMessage(chatId: number, messageId: number): Promise<void>;
    unpinChatMessage(chatId: number, messageId: number): Promise<void>;
    editMessageText(chatId: number, messageId: number, text: string, parseMode?: string): Promise<void>;
    getChatId(): number | undefined;
    getLastMessageId(): number | undefined;
  };
}

// ─── Extension Definition ──────────────────────────────────────────────────

export type Runtime = "pi" | "pi-durable";

/** Context passed to extension factory */
/** Sweep manager for librarian mode */
export interface SweepManager {
  getStatus(): SweepStatus;
  isRunning(): boolean;
  start(): Promise<{ started: boolean; reason?: string }>;
  stop(): Promise<void>;
}

export interface SweepStatus {
  state: "idle" | "running" | "completed" | "failed";
  startedAt?: string;
  completedAt?: string;
  progress?: string;
  result?: {
    processed: number;
    created: number;
    merged: number;
    rejected: number;
    parked: number;
    remaining: number;
    duration: number;
  };
  error?: string;
}

export interface ExtensionContext {
  /** Wolf den path */
  wolfDen: string;
  /** Wolf name */
  wolfName: string;
  /** Subscribed domains */
  domains: string[];
  /** Full wolf config (for advanced use) */
  wolfConfig: Record<string, unknown>;
  /** Shared telegram state (if telegram is enabled) */
  telegram?: TelegramSharedState;
  /** Sweep manager (if librarian mode is enabled) */
  sweep?: SweepManager;
}

export interface Extension {
  /** Unique extension name */
  name: string;
  
  /** Which runtimes this extension supports. Omit for both. */
  runtimes?: Runtime[];
  
  /** Tools provided by this extension */
  tools?: Tool[];
  
  /** System prompt sections */
  sections?: Section[];
  
  /** Lifecycle hooks */
  hooks?: Hooks;
}

/** Extension factory function signature */
export type ExtensionFactory<TConfig = unknown> = (
  config: TConfig,
  context: ExtensionContext
) => Extension;

// ─── Builder Functions ─────────────────────────────────────────────────────

/**
 * Define an extension using the unified interface.
 */
export function defineExtension(ext: Extension): Extension {
  return ext;
}

/**
 * Define a tool with type-safe parameters.
 */
export function defineTool(tool: Tool): Tool {
  return tool;
}

/**
 * Define a system prompt section.
 */
export function section(
  name: string,
  render: (context: SectionContext) => string | undefined
): Section {
  return { name, render };
}

/**
 * Check if an extension supports a given runtime.
 */
export function supportsRuntime(ext: Extension, runtime: Runtime): boolean {
  if (!ext.runtimes || ext.runtimes.length === 0) {
    // No runtimes specified = supports all
    return true;
  }
  return ext.runtimes.includes(runtime);
}
