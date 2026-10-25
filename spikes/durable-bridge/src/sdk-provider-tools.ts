/**
 * GATE SPIKE: claude-bridge provider WITH tool passthrough. pi-durable owns the loop and executes tools; the SDK
 * only ever sees them as MCP tools whose handlers never run anything — they park until durable returns the result.
 *
 * Contract (mirrors stock anthropic-messages.js):
 *  - tools in  : getCurrentTools(context.messages) (leading system messages' toolsAdded/Removed replayed)
 *  - tools out : toolcall_start / toolcall_delta(partial_json) / toolcall_end{toolCall}, then done{reason:"toolUse"}
 *  - results in: next call's transcript ends [assistant(toolCalls), toolResult...]
 * Modes (GATE_MODE): "park" (default) keeps ONE query alive across rounds (old bridge's trick);
 *                    "replay" ends/kills the query at tool_use and rebuilds a fresh query from the transcript each round.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getCurrentTools, getCurrentSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import type { AssistantMessage, Model, SimpleStreamOptions, Tool, TranscriptContext } from "@earendil-works/pi-ai";
import { childEnv } from "./sdk-provider.ts";

export const PROVIDER_ID = "claude-bridge";
const SERVER = "durable";
const PREFIX = `mcp__${SERVER}__`;
const TOOL_USE_ID_META = "claudecode/toolUseId";

/** Observability for the gate: one row per streamSimple call, plus process/query counters. */
export const stats = { queriesSpawned: 0, rounds: [] as any[], mode: (process.env.GATE_MODE ?? "park") as "park" | "replay" };

const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const text = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => (b.type === "text" ? b.text : b.type === "image" ? "[image]" : "")).filter(Boolean).join("\n") : "";

/** SDK error class -> text that pi-ai's isRetryableAssistantError (utils/retry.js) classifies correctly. */
export function mapSdkError(code: string | undefined, detail: string): string {
  switch (code) {
    case "rate_limit": return `rate limit (429): ${detail}`;            // retryable: matches "rate.?limit"
    case "overloaded": return `overloaded: ${detail}`;                  // retryable
    case "server_error": return `server error (500): ${detail}`;        // retryable
    case "billing_error": case "account_on_hold": return `billing: ${detail}`; // NON-retryable ("billing")
    case "authentication_failed": case "oauth_org_not_allowed": case "verification_required": return `authentication_failed: ${detail}`;
    default: return detail;
  }
}
/** Max-plan usage-limit exhaustion arrives as text; make it NON-retryable (resets in hours). */
const USAGE_LIMIT = /usage limit|limit reached|5-hour|weekly limit/i;

type McpResult = { content: any[]; isError?: boolean };
type Round = { stream: ReturnType<typeof createAssistantMessageEventStream>; out: AssistantMessage; started: boolean; blocks: Map<number, number>; t0: number };
type Live = {
  q: ReturnType<typeof query>;
  pending: Map<string, (r: McpResult) => void>;   // handler parked, waiting for durable's result
  results: Map<string, McpResult>;                // result landed before handler
  expecting: Set<string>;                         // tool_use ids emitted to durable, result not yet delivered
  cur: Round | null;
  dead: boolean;
  ps?: ReturnType<typeof promptStream>;
};
let live: Live | undefined;

/** Minimal long-lived streaming-input prompt (after pi-claude-bridge prompt-stream.ts): lets us write a steer to the CLI's stdin mid-query. */
function promptStream() {
  const queue: any[] = []; let wake: (() => void) | null = null; let done = false;
  async function* gen() {
    while (true) {
      while (!queue.length && !done) await new Promise<void>((r) => (wake = r));
      const it = queue.shift(); if (!it) return;
      yield it.msg; it.ack();
    }
  }
  return {
    stream: gen(),
    push: (content: any, priority?: "now" | "next" | "later") => new Promise<void>((ack) => { queue.push({ msg: { type: "user", message: { role: "user", content }, parent_tool_use_id: null, ...(priority ? { priority } : {}) }, ack }); wake?.(); wake = null; }),
    end: () => { done = true; wake?.(); wake = null; },
  };
}

function mcpServer(tools: Tool[], L: () => Live) {
  const server = new McpServer({ name: SERVER, version: "1.0.0" }, { capabilities: { tools: {} } });
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters as any })),
  }));
  server.server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const id = (req.params as any)._meta?.[TOOL_USE_ID_META];
    if (typeof id !== "string") throw new Error("tools/call missing claudecode/toolUseId");
    const l = L();
    // NOTHING EXECUTES HERE. Park until durable's engine returns the result via the next streamSimple call.
    if (l.results.has(id)) { const r = l.results.get(id)!; l.results.delete(id); return r as any; }
    return new Promise<any>((resolve) => l.pending.set(id, resolve));
  });
  return { type: "sdk" as const, name: SERVER, instance: server };
}

function sdkOptions(model: Model<any>, systemPrompt: string, tools: Tool[], L: () => Live) {
  return {
    cwd: process.cwd(), env: childEnv(), systemPrompt, model: model.id,
    maxTurns: stats.mode === "park" ? 12 : 1,
    tools: [], skills: [], strictMcpConfig: true, persistSession: false, settingSources: [],
    settings: { autoMemoryEnabled: false },
    includePartialMessages: true,
    mcpServers: { [SERVER]: mcpServer(tools, L) },
    allowedTools: tools.map((t) => PREFIX + t.name), // auto-approve (no human) — they cannot execute anything anyway
  } as any;
}

/** Transcript -> prompt for a FRESH query (replay mode / crash recovery). Tool pairs are rendered as text. */
export function convertWithTools(context: TranscriptContext) {
  const sysMsg = getCurrentSystemMessage(context.messages as any);
  const sys: string[] = [];
  if (sysMsg) { sys.push(text((sysMsg as any).content)); for (const v of Object.values((sysMsg as any).sections ?? {})) if (v) sys.push(v as string); }
  const turns: string[] = [];
  for (const m of context.messages as any[]) {
    if (m.role === "user") turns.push(`[user]\n${text(m.content)}`);
    else if (m.role === "assistant") {
      const parts = m.content.map((b: any) => (b.type === "text" ? b.text : b.type === "toolCall" ? `[called tool ${b.name} id=${b.id} args=${JSON.stringify(b.arguments)}]` : "")).filter(Boolean);
      if (parts.length) turns.push(`[assistant]\n${parts.join("\n")}`);
    } else if (m.role === "toolResult") turns.push(`[result of tool call ${m.toolCallId} (${m.toolName})${m.isError ? " ERROR" : ""}]\n${text(m.content)}`);
  }
  const last = (context.messages as any[]).at(-1);
  const single = turns.length === 1 && last?.role === "user";
  const prompt = single ? text(last.content) : turns.join("\n\n") + "\n\n[Continue the conversation from the last entry. Do not repeat tool calls whose results are shown.]";
  return { systemPrompt: sys.join("\n\n"), prompt };
}

function finish(r: Round, ev: any) { r.stream.push(ev); r.stream.end(); }

/** Map one SDK message onto the current round's pi stream. */
function pump(l: Live, model: Model<any>, msg: any) {
  const r = l.cur;
  if (msg.type === "rate_limit_event") { (stats as any).lastRateLimit = msg.rate_limit_info; return; }
  if (!r) return; // between rounds: nothing is listening (leftovers are dropped, as in the old bridge)
  if (msg.type === "assistant" && msg.error) {
    r.out.stopReason = "error";
    r.out.errorMessage = mapSdkError(msg.error, text(msg.message?.content) || msg.error);
    return;
  }
  if (msg.type === "stream_event" && !msg.parent_tool_use_id) {
    const e = msg.event;
    const out = r.out;
    if (e.type === "message_start") {
      if (!r.started) { r.stream.push({ type: "start", partial: out }); r.started = true; }
      if (e.message?.usage) { out.usage.input = e.message.usage.input_tokens ?? 0; out.usage.cacheRead = e.message.usage.cache_read_input_tokens ?? 0; out.usage.cacheWrite = e.message.usage.cache_creation_input_tokens ?? 0; }
    } else if (e.type === "content_block_start") {
      const cb = e.content_block;
      if (cb.type === "text") { out.content.push({ type: "text", text: "" }); r.blocks.set(e.index, out.content.length - 1); r.stream.push({ type: "text_start", contentIndex: out.content.length - 1, partial: out }); }
      else if (cb.type === "tool_use") {
        const name = String(cb.name).startsWith(PREFIX) ? cb.name.slice(PREFIX.length) : cb.name; // MCP name -> pi tool name
        out.content.push({ type: "toolCall", id: cb.id, name, arguments: {}, partialJson: "" } as any);
        r.blocks.set(e.index, out.content.length - 1);
        l.expecting.add(cb.id);
        r.stream.push({ type: "toolcall_start", contentIndex: out.content.length - 1, partial: out });
      }
    } else if (e.type === "content_block_delta") {
      const i = r.blocks.get(e.index); if (i === undefined) return;
      const b: any = out.content[i];
      if (e.delta.type === "text_delta") { b.text += e.delta.text; r.stream.push({ type: "text_delta", contentIndex: i, delta: e.delta.text, partial: out }); }
      else if (e.delta.type === "input_json_delta") {
        b.partialJson += e.delta.partial_json;
        try { b.arguments = JSON.parse(b.partialJson); } catch { /* partial */ }
        r.stream.push({ type: "toolcall_delta", contentIndex: i, delta: e.delta.partial_json, partial: out });
      }
    } else if (e.type === "content_block_stop") {
      const i = r.blocks.get(e.index); if (i === undefined) return;
      const b: any = out.content[i];
      if (b.type === "text") r.stream.push({ type: "text_end", contentIndex: i, content: b.text, partial: out });
      else if (b.type === "toolCall") { b.arguments = b.partialJson ? JSON.parse(b.partialJson) : {}; delete b.partialJson; r.stream.push({ type: "toolcall_end", contentIndex: i, toolCall: b, partial: out }); }
    } else if (e.type === "message_delta") {
      if (e.usage) out.usage.output = e.usage.output_tokens ?? out.usage.output;
      if (e.delta?.stop_reason) (r as any).stop = e.delta.stop_reason;
    } else if (e.type === "message_stop") {
      out.usage.totalTokens = out.usage.input + out.usage.output + out.usage.cacheRead + out.usage.cacheWrite;
      const stop = (r as any).stop;
      l.cur = null;
      stats.rounds.at(-1) && Object.assign(stats.rounds.at(-1), { ms: Date.now() - r.t0, usage: { ...out.usage, cost: undefined }, stop });
      if (out.stopReason === "error") finish(r, { type: "error", reason: "error", error: out });
      else if (stop === "tool_use") {
        out.stopReason = "toolUse";
        finish(r, { type: "done", reason: "toolUse", message: out });
        // replay mode: the round is over for this process; the parked handler must die with it.
        if (stats.mode === "replay") { l.dead = true; try { l.q.close(); } catch {} if (live === l) live = undefined; }
      } else { out.stopReason = stop === "max_tokens" ? "length" : "stop"; l.ps?.end(); /* final answer: close stdin so the CLI exits */ finish(r, { type: "done", reason: out.stopReason as any, message: out }); }
    }
    return;
  }
  if (msg.type === "result" && (msg.is_error || msg.subtype !== "success")) {
    const detail = typeof msg.result === "string" && msg.result ? msg.result : `sdk result ${msg.subtype}`;
    r.out.stopReason = "error";
    r.out.errorMessage = USAGE_LIMIT.test(detail) ? `quota exceeded: ${detail}` : r.out.errorMessage ?? mapSdkError(undefined, detail);
    l.cur = null;
    finish(r, { type: "error", reason: "error", error: r.out });
  }
}

async function consume(l: Live, model: Model<any>) {
  try {
    for await (const msg of l.q as AsyncIterable<any>) { if (l.dead) break; pump(l, model, msg); }
  } catch (e) {
    const r = l.cur; l.cur = null;
    if (r && !l.dead) { r.out.stopReason = "error"; r.out.errorMessage = e instanceof Error ? e.message : String(e); if (!r.started) r.stream.push({ type: "start", partial: r.out }); finish(r, { type: "error", reason: "error", error: r.out }); }
  } finally {
    // query ended while someone is still waiting (e.g. process died / result without message_stop)
    const r = l.cur; l.cur = null; l.dead = true; if (live === l) live = undefined;
    if (r) { r.out.stopReason = "error"; r.out.errorMessage = r.out.errorMessage ?? "claude process ended unexpectedly (connection lost)"; if (!r.started) r.stream.push({ type: "start", partial: r.out }); finish(r, { type: "error", reason: "error", error: r.out }); }
  }
}

function streamSimple(model: Model<any>, context: TranscriptContext, options?: SimpleStreamOptions) {
  const stream = createAssistantMessageEventStream();
  const out: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: zeroUsage(), stopReason: "pending", timestamp: Date.now() } as any;
  const round: Round = { stream, out, started: false, blocks: new Map(), t0: Date.now() };
  const row: any = { at: Date.now(), msgs: context.messages.length, path: "" };
  stats.rounds.push(row);
  const msgs = context.messages as any[];
  // trailing toolResults = results for the last assistant message's tool calls
  const trailing: any[] = [];
  for (let i = msgs.length - 1; i >= 0 && msgs[i].role !== "assistant"; i--) if (msgs[i].role === "toolResult") trailing.unshift(msgs[i]);

  // durable aborts each call's signal when the call is over; only act while THIS round is the one streaming.
  const abort = () => { if (live && live.cur === round) { live.dead = true; try { live.q.close(); } catch {} live = undefined; } };
  options?.signal?.addEventListener("abort", abort, { once: true });

  if (process.env.GATE_DEBUG) console.error('[dbg]', 'live', !!live, 'dead', live?.dead, 'expecting', live && [...live.expecting], 'trailing', trailing.map((t) => t.toolCallId), 'mode', stats.mode);
  const continuing = stats.mode === "park" && live && !live.dead && trailing.length > 0 && trailing.every((t) => live!.expecting.has(t.toolCallId));
  if (continuing) {
    // CONTINUE the parked query: swap in this call's stream, then release the handlers with durable's results.
    const l = live!;
    row.path = "continue-parked";
    l.cur = round;
    // user messages after the last assistant (steer/follow-up injected mid-tool) must reach the CLI BEFORE the tool results
    const steers = msgs.slice(msgs.findLastIndex((m) => m.role === "assistant") + 1).filter((m) => m.role === "user").map((m) => text(m.content));
    void (async () => {
      for (const st of steers) await l.ps!.push(st, "next"); // resolves once written to stdin
      row.steersPushed = steers.length;
      deliver();
    })();
    function deliver() {
    for (const t of trailing) {
      const res: McpResult = { content: t.content.map((b: any) => (b.type === "text" ? { type: "text", text: b.text } : b)), isError: t.isError };
      l.expecting.delete(t.toolCallId);
      const p = l.pending.get(t.toolCallId);
      if (p) { l.pending.delete(t.toolCallId); p(res); } else l.results.set(t.toolCallId, res);
    }
    }
    return stream;
  }

  // FRESH query (first round, replay mode, or crash recovery with no parked process).
  if (live) { live.dead = true; try { live.q.close(); } catch {} live = undefined; }
  row.path = trailing.length ? "fresh-rebuild-with-history" : "fresh";
  const tools = getCurrentTools(context.messages as any);
  const { systemPrompt, prompt } = convertWithTools(context);
  const l = { pending: new Map(), results: new Map(), expecting: new Set(), cur: round, dead: false } as Live;
  if (stats.mode === "park") { l.ps = promptStream(); void l.ps.push(prompt); }
  l.q = query({ prompt: l.ps ? l.ps.stream : prompt, options: sdkOptions(model, systemPrompt, tools, () => l) });
  stats.queriesSpawned++;
  row.prompt = prompt.slice(0, 600);
  live = l;
  void consume(l, model);
  return stream;
}

/** Kill any parked query (end of run / tests). */
export function shutdown() { if (live) { live.dead = true; try { live.q.close(); } catch {} live = undefined; } }

export function claudeBridgeToolsProvider() {
  const model = (id: string, name: string) => ({
    id, name, api: PROVIDER_ID, provider: PROVIDER_ID, baseUrl: PROVIDER_ID, input: ["text"] as ("text")[],
    reasoning: false, contextWindow: 200_000, maxTokens: 64_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  return createProvider({
    id: PROVIDER_ID, name: "Claude (subscription via Agent SDK, tools passthrough)",
    auth: { apiKey: { name: "Claude Code OAuth login (ambient)", resolve: async () => ({ auth: { apiKey: "not-used" }, source: "claude-code-oauth" }) } },
    models: [model("claude-haiku-5-5", "Claude Haiku 5.5 (subscription)")],
    api: { stream: (m: any, c: any, o: any) => streamSimple(m, c, o), streamSimple: streamSimple as any },
  } as any);
}
