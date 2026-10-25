/**
 * Shared rig for the durable-bridge spike. Bare engine only: no wolfpack extensions, no WORK_*, no den, no KB.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "typebox";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  watchEvents,
  type AgentEvent,
  type Conversation,
  type SnapshotEvent,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

export const ctx = BACKGROUND_CONTEXT;
export const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SCRATCH = join(HERE, ".scratch");
export const EVIDENCE = join(HERE, "evidence");
export const MODEL = { provider: "anthropic", modelId: process.env.SPIKE_MODEL ?? "claude-haiku-5-5" } as const;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Load ONLY ANTHROPIC_API_KEY from ~/.wolfpack/.env if not already in env. Never printed. */
export function loadKey(): void {
  if (process.env.ANTHROPIC_API_KEY) return;
  const f = join(homedir(), ".wolfpack", ".env");
  if (!existsSync(f)) throw new Error("no ANTHROPIC_API_KEY in env and no ~/.wolfpack/.env");
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.*)\s*$/);
    if (m) process.env.ANTHROPIC_API_KEY = m[1].replace(/^["']|["']$/g, "");
  }
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not found");
}

/** Counters so scripts can prove what ran (and how often) across a crash. */
export const toolLog: { name: string; args: unknown; at: number }[] = [];

export function makeTools(opts: { slowReplay?: "safe" | "unsafe" } = {}) {
  const echo = defineTool({
    name: "echo",
    description: "Echo back the given text.",
    parameters: Type.Object({ text: Type.String() }),
    replay: "safe",
    async execute(args) {
      toolLog.push({ name: "echo", args, at: Date.now() });
      return { output: [{ type: "text", text: `echo: ${args.text}` }] };
    },
  });
  const add = defineTool({
    name: "add",
    description: "Add two numbers and return the sum.",
    parameters: Type.Object({ a: Type.Number(), b: Type.Number() }),
    replay: "safe",
    async execute(args) {
      toolLog.push({ name: "add", args, at: Date.now() });
      const sum = args.a + args.b;
      return { output: [{ type: "text", text: String(sum) }], details: { sum } };
    },
  });
  // Long-running tool: streams running output + details so a late watcher sees them in the snapshot.
  const slow = defineTool({
    name: "slow",
    description: "Wait for the given number of seconds, reporting progress, then return 'done'.",
    parameters: Type.Object({ seconds: Type.Number() }),
    replay: opts.slowReplay ?? "unsafe",
    async execute(args, api) {
      toolLog.push({ name: "slow", args, at: Date.now() });
      for (let i = 1; i <= args.seconds; i++) {
        await sleep(1000);
        api.output(`tick ${i}/${args.seconds}\n`);
        await api.details({ tick: i, of: args.seconds }, ctx);
      }
      return { output: [{ type: "text", text: "done" }] };
    },
  });
  // Two-turn ask pattern: tool records a pending question and ends the run (control.terminate).
  const ask = defineTool({
    name: "ask_user",
    description: "Ask the human a question. Ends your turn; their answer arrives as the next user message. Use whenever you need info only the human has.",
    parameters: Type.Object({ question: Type.String() }),
    replay: "safe",
    async execute(args) {
      toolLog.push({ name: "ask_user", args, at: Date.now() });
      return {
        output: [{ type: "text", text: `Question sent to user: ${args.question}` }],
        details: { pendingQuestion: args.question },
        control: { terminate: true },
      };
    },
  });
  return defineExtension({ name: "spike-tools", tools: [echo, add, slow, ask] });
}

export type Rig = {
  harness: Harness;
  registry: ReturnType<typeof createRegistry>;
  commits: { seq: number; kinds: string[] }[];
  close: () => Promise<void>;
};

export async function openRig(store: string, opts: { resume?: boolean; slowReplay?: "safe" | "unsafe"; reportErrors?: boolean } = {}): Promise<Rig> {
  loadKey();
  mkdirSync(dirname(store), { recursive: true });
  const models = createModels();
  models.setProvider(anthropicProvider());
  const registry = createRegistry();
  registry.install(makeTools({ slowReplay: opts.slowReplay }));
  const storage = await openNodeSqliteStorage(store);
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? SCRATCH }),
      onReport: opts.reportErrors === false ? undefined : (e) => console.error("[onReport]", e instanceof Error ? e.message : e),
    },
    ctx,
  );
  const commits: Rig["commits"] = [];
  harness.subscribeCommits((pub) => {
    commits.push({ seq: pub.seq as number, kinds: pub.changes.map((c) => (c.type === "document" ? `doc:${c.record.kind}` : c.type)) });
  });
  if (opts.resume !== false) harness.resume();
  return { harness, registry, commits, close: () => harness.close(ctx) };
}

export async function rootConv(rig: Rig, extra: { instructions?: string } = {}): Promise<Conversation> {
  const conv = await rig.harness.root(ctx, {
    agent: { model: MODEL, thinkingLevel: null, instructions: extra.instructions ?? "Be extremely terse. Follow tool instructions exactly." },
  });
  return conv;
}

export async function createdConv(rig: Rig, extra: { instructions?: string } = {}): Promise<Conversation> {
  return rig.harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: { model: MODEL, thinkingLevel: null, instructions: extra.instructions ?? "Be extremely terse. Follow tool instructions exactly." },
    },
    ctx,
  );
}

// ---------------------------------------------------------------- recording

export type Batch = { n: number; tMs: number; events: AgentEvent[] };
export type Recording = {
  label: string;
  attachedAtMs: number;
  snapshot: SnapshotEvent;
  batches: Batch[];
  stop: () => Promise<unknown>;
  /** Resolves when `pred` matches an event (checked as batches arrive). */
  waitFor: (pred: (e: AgentEvent) => boolean, timeoutMs?: number) => Promise<AgentEvent>;
  closed: Promise<unknown>;
};

export async function record(rig: Rig, conv: Conversation, label: string, t0 = Date.now()): Promise<Recording> {
  const stream = await watchEvents(rig.harness, conv.id, ctx);
  const batches: Batch[] = [];
  const waiters: { pred: (e: AgentEvent) => boolean; res: (e: AgentEvent) => void }[] = [];
  let n = 0;
  stream.start(async (events) => {
    batches.push({ n: n++, tMs: Date.now() - t0, events: [...events] });
    for (const e of events) for (const w of [...waiters]) if (w.pred(e)) { waiters.splice(waiters.indexOf(w), 1); w.res(e); }
  });
  return {
    label,
    attachedAtMs: Date.now() - t0,
    snapshot: stream.snapshot,
    batches,
    stop: () => stream.stop(),
    closed: stream.closed,
    waitFor: (pred, timeoutMs = 60_000) =>
      new Promise((res, rej) => {
        for (const b of batches) for (const e of b.events) if (pred(e)) return res(e);
        const t = setTimeout(() => rej(new Error(`waitFor timeout (${label})`)), timeoutMs);
        waiters.push({ pred, res: (e) => (clearTimeout(t), res(e)) });
      }),
  };
}

export const flat = (r: Recording) => r.batches.flatMap((b) => b.events);
/**
 * Text as a streaming client reconstructs it: message_start's partial, then text_delta changes. The last tail of a
 * fast reply may only exist in message_end (partials are throttled), so also see `finalTextOf`.
 */
export const textOf = (r: Recording) => {
  let t = "";
  for (const e of flat(r) as any[]) {
    if (e.type === "message_start" && e.message.role === "assistant") t += e.message.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
    if (e.type === "message_update") for (const c of e.changes) if (c.type === "text_delta") t += c.delta;
  }
  return t;
};
export const finalTextOf = (r: Recording) =>
  (flat(r) as any[])
    .filter((e) => e.type === "message_end" && e.entry.kind === "pi.assistant")
    .map((e) => e.entry.model[0].content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(""))
    .join("|");

/** Compact one-line-per-event summary for console + FINDINGS. */
export function summarize(e: AgentEvent): string {
  const a = e as any;
  switch (e.type) {
    case "message_update":
      return `message_update[${a.changes.map((c: any) => c.type + (c.delta !== undefined ? `(${JSON.stringify(String(c.delta).slice(0, 20))})` : "")).join(",")}]`;
    case "message_start":
      return `message_start(${a.message.role})`;
    case "message_end":
      return `message_end(entry ${a.entry.id} ${a.entry.kind})`;
    case "tool_execution_start":
    case "tool_execution_end":
    case "tool_execution_update":
      return `${e.type}(${a.toolName} ${a.toolCallId})`;
    case "entry_appended":
      return `entry_appended(${a.entry.id} ${a.entry.kind})`;
    case "submission":
      return `submission(${a.record.id} ${a.record.status})`;
    case "inbox_update":
      return `inbox_update(${a.items.map((i: any) => i.mode).join(",")})`;
    case "run_start":
    case "run_end":
      return `${e.type}(inputs ${a.inputs.join(",")})`;
    case "snapshot":
      return "snapshot";
    default:
      return e.type;
  }
}

// ------------------------------------------------------------ sanitization

/** Strip signatures / encrypted blobs, trim long strings; keep structure intact. */
export function sanitize<T>(v: T): T {
  return JSON.parse(
    JSON.stringify(v, (k, val) => {
      if (k === "thinkingSignature" || k === "signature" || k === "textSignature" || k === "responseId") return "<redacted>";
      if (typeof val === "string" && val.length > 400) return val.slice(0, 400) + `…<+${val.length - 400}>`;
      return val;
    }),
  );
}

export function saveEvidence(name: string, data: unknown): string {
  mkdirSync(EVIDENCE, { recursive: true });
  const f = join(EVIDENCE, name);
  writeFileSync(f, JSON.stringify(sanitize(data), null, 2) + "\n");
  return f;
}

export function recToJson(r: Recording) {
  return { label: r.label, attachedAtMs: r.attachedAtMs, snapshot: r.snapshot, batches: r.batches };
}

export function freshStore(name: string): string {
  mkdirSync(SCRATCH, { recursive: true });
  const f = join(SCRATCH, `${name}.sqlite`);
  for (const suffix of ["", "-wal", "-shm"]) rmSync(f + suffix, { force: true });
  return f;
}
