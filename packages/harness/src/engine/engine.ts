/**
 * WolfEngine: the one typed seam over @earendil-works/pi-durable. No HTTP, no protocol wire concerns; the serving
 * layer composes this with `mapEngineEvents` + `stampEvent`. Nothing outside src/engine/ should import pi-durable
 * going forward (existing harness internals migrate later).
 */
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import {
  ConversationBusy,
  createRegistry,
  Harness,
  watchEvents,
  type AgentChange,
  type Conversation,
  type Extension,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { attachConversationReader } from "./conversation-reader.js";
import { backupSessionStore, type BackupResult } from "./backup.js";
import type { EngineEvent, EngineSnapshot } from "./events.js";
import { engineVersion } from "./version.js";

const ctx = BACKGROUND_CONTEXT;

export type WhenBusy = "steer" | "followUp" | "reject";
export type ThinkingLevel = NonNullable<AgentChange["thinkingLevel"]>;

/** Thrown by submit() with whenBusy "reject" while a turn is running. Serving maps it to `busy` (409). */
export class EngineBusyError extends Error {
  constructor() {
    super("conversation is busy");
    this.name = "EngineBusyError";
  }
}

export interface WolfEngineOptions {
  /** Default: pi-ai's anthropic provider (api transport; reads ANTHROPIC_API_KEY). */
  models?: Models;
  /** Installed in the registry; conversations select tools from these by name. */
  extensions?: readonly Extension[];
  /** Working directory of conversations that don't set their own. Default: process.cwd(). */
  cwd?: string;
  /** Back up the store before the first open under this engine version. Default true. See backup.ts. */
  backup?: boolean;
  /** Engine fault reports (task faults, session failures). */
  onReport?: (error: unknown) => void;
}

export interface ConfigureOptions {
  model?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel | null;
  /** Names of tools (from installed extensions) this conversation may use. */
  tools?: readonly string[];
  cwd?: string;
  /** System-prompt instructions rendered after every extension section. `null` clears. */
  instructions?: string | null;
}

export interface SubmitOptions {
  input: string;
  whenBusy: WhenBusy;
}

export interface SubmitResult {
  /** Engine id of the admitted submission (the protocol's messageId). */
  messageId: string;
  disposition: "started" | "steered" | "queued";
}

export interface EngineWatch {
  /** State at attach, captured atomically with the subscription (no gap/dup before the first batch). */
  snapshot: EngineSnapshot;
  /** One array per engine commit. Ends when stop() is called or the engine closes. */
  batches: AsyncIterable<readonly EngineEvent[]>;
  stop(): Promise<void>;
}

export interface EngineConversation {
  readonly id: string;
  submit(opts: SubmitOptions): Promise<SubmitResult>;
  /** Abort the running turn; resolves when idle. The event stream reports it (turn-end reason aborted). */
  abort(): Promise<void>;
  configure(opts: ConfigureOptions): Promise<void>;
  /** Engine-native events; feed `batches` through mapEngineEvents (seed with `snapshot`). */
  watch(): Promise<EngineWatch>;
}

export interface WolfEngine {
  /** pi-durable version in use. */
  readonly version: string;
  /** Set when open() backed up the store. */
  readonly backup?: BackupResult;
  readonly conversations: {
    /** The store's reserved root conversation, created on first call. `init` applies only at creation. */
    root(init?: ConfigureOptions): Promise<EngineConversation>;
    get(id: string): Promise<EngineConversation | undefined>;
    create(init?: ConfigureOptions): Promise<EngineConversation>;
  };
  /**
   * @internal test seam: the opened pi-durable Harness, for tests that must create forks and task-owned
   * conversations (nothing in the serving path does yet). Don't use it elsewhere.
   */
  readonly harness: Harness;
  /** Names of every tool the installed extensions register (what a conversation with no `tools` selection is offered). */
  toolNames(): string[];
  /** Continue interrupted work. Call on every start. */
  resume(): void;
  close(): Promise<void>;
}

export async function openWolfEngine(storagePath: string, opts: WolfEngineOptions = {}): Promise<WolfEngine> {
  const version = engineVersion();
  const backup = opts.backup === false ? undefined : backupSessionStore(storagePath, { engineVersion: version });

  const models = opts.models ?? defaultModels();
  const registry = createRegistry();
  for (const ext of opts.extensions ?? []) registry.install(ext);

  const storage = await openNodeSqliteStorage(storagePath);
  const defaultCwd = opts.cwd ?? process.cwd();
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? defaultCwd }),
      onReport: opts.onReport,
    },
    ctx,
  );

  const detachReader = attachConversationReader(harness, dirname(storagePath));

  const toolsByName = (names: readonly string[]) => {
    const all = registry.snapshot().tools();
    return names.map((n) => {
      const hit = all.find((t) => t.tool.name === n);
      if (!hit) throw new Error(`unknown tool: ${n}`);
      return hit.tool;
    });
  };

  const agentChange = (c: ConfigureOptions = {}) => ({
    ...(c.model ? { model: c.model } : {}),
    ...(c.thinkingLevel !== undefined ? { thinkingLevel: c.thinkingLevel } : {}),
    ...(c.tools ? { tools: toolsByName(c.tools) } : {}),
    ...(c.cwd ? { cwd: c.cwd } : {}),
    ...(c.instructions !== undefined ? { instructions: c.instructions } : {}),
  });

  const wrap = (conv: Conversation): EngineConversation => ({
    id: String(conv.id),

    async submit({ input, whenBusy }) {
      let sub;
      try {
        sub = await conv.submit({ type: "input", content: input, whenBusy }, ctx);
      } catch (err) {
        if (err instanceof ConversationBusy) throw new EngineBusyError();
        throw err;
      }
      const status = (await sub.status(ctx)).status;
      const disposition = status === "queued" ? (whenBusy === "steer" ? "steered" : "queued") : "started";
      return { messageId: String(sub.id), disposition };
    },

    abort: () => conv.abort(ctx),

    async configure(c) {
      await conv.configure(agentChange(c), ctx);
    },

    async watch() {
      const stream = await watchEvents(harness, conv.id, ctx);
      const queue: (readonly EngineEvent[])[] = [];
      let wake: (() => void) | undefined;
      let done = false;
      stream.closed.then(() => {
        done = true;
        wake?.();
      });
      stream.start(async (events) => {
        queue.push(events);
        wake?.();
      });
      async function* batches() {
        while (true) {
          const next = queue.shift();
          if (next) yield next;
          else if (done) return;
          else await new Promise<void>((r) => (wake = r));
        }
      }
      return {
        snapshot: stream.snapshot,
        batches: batches(),
        stop: async () => {
          await stream.stop();
        },
      };
    },
  });

  return {
    version,
    backup,
    conversations: {
      async root(init) {
        const conv = await harness.root(ctx, { agent: agentChange(init) });
        return wrap(conv);
      },
      async get(id) {
        const conv = await harness.conversation(Number(id) as never, ctx);
        return conv ? wrap(conv) : undefined;
      },
      async create(init) {
        return wrap(await harness.createConversation({ ownership: { kind: "ownerless" }, agent: agentChange(init) }, ctx));
      },
    },
    harness,
    toolNames: () => registry.snapshot().tools().map((t) => t.tool.name),
    resume: () => harness.resume(),
    close: async () => {
      detachReader();
      await harness.close(ctx);
    },
  };
}

function defaultModels(): Models {
  const models = createModels();
  models.setProvider(anthropicProvider());
  return models;
}
