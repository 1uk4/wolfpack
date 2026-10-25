/**
 * SPIKE: pi-ai Provider "claude-bridge" over the Claude Agent SDK (Max subscription, no tools).
 * One query() per streamSimple call, maxTurns:1, tools:[]. Auth = whatever the `claude` CLI finds (OAuth login).
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";

export const PROVIDER_ID = "claude-bridge";

const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

/** Strip API credentials so the child falls back to the OAuth login (Claude Code prefers ANTHROPIC_API_KEY). */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { ANTHROPIC_API_KEY: _k, ANTHROPIC_AUTH_TOKEN: _t, ...rest } = env;
  return { ...rest, ENABLE_CLAUDEAI_MCP_SERVERS: "0", DISABLE_AUTO_COMPACT: "1" };
}

const text = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => (b.type === "text" ? b.text : b.type === "image" ? "[image]" : "")).filter(Boolean).join("\n") : "";

/** Transcript -> (systemPrompt, prompt). No tools: history is flattened to a labelled transcript; last user msg is the ask. */
export function convert(context: TranscriptContext): { systemPrompt: string; prompt: string } {
  const sys: string[] = [];
  const turns: string[] = [];
  for (const m of context.messages as any[]) {
    if (m.role === "system") {
      sys.push(text(m.content));
      for (const [k, v] of Object.entries(m.sections ?? {})) if (v) sys.push(v as string);
    } else if (m.role === "user") turns.push(`[user]\n${text(m.content)}`);
    else if (m.role === "assistant") turns.push(`[assistant]\n${m.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("")}`);
    else if (m.role === "toolResult") turns.push(`[tool result ${m.toolName}]\n${text(m.content)}`);
  }
  const last = (context.messages as any[]).at(-1);
  const prompt = turns.length <= 1 && last?.role === "user" ? text(last.content) : turns.join("\n\n");
  return { systemPrompt: sys.join("\n\n"), prompt };
}

function streamSimple(model: Model<any>, context: TranscriptContext, options?: SimpleStreamOptions) {
  const stream = createAssistantMessageEventStream();
  const out: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: zeroUsage(), stopReason: "pending", timestamp: Date.now() } as any;
  void (async () => {
    let q: ReturnType<typeof query> | undefined;
    const abort = () => { try { q?.close(); } catch {} };
    try {
      const { systemPrompt, prompt } = convert(context);
      q = query({
        prompt,
        options: {
          cwd: process.cwd(),
          env: childEnv(),
          systemPrompt,
          model: model.id,
          maxTurns: 1,
          tools: [],
          skills: [],
          strictMcpConfig: true,
          persistSession: false,
          settingSources: [],
          settings: { autoMemoryEnabled: false },
          includePartialMessages: true,
        } as any,
      });
      options?.signal?.addEventListener("abort", abort, { once: true });
      stream.push({ type: "start", partial: out });
      let idx = -1; // content index of the open text block
      let final = "";
      let err: string | undefined;
      for await (const msg of q as AsyncIterable<any>) {
        if (options?.signal?.aborted) break;
        if (msg.type === "stream_event") {
          const e = msg.event;
          if (e?.type === "content_block_start" && e.content_block?.type === "text") {
            out.content.push({ type: "text", text: "" });
            idx = out.content.length - 1;
            stream.push({ type: "text_start", contentIndex: idx, partial: out });
          } else if (e?.type === "content_block_delta" && e.delta?.type === "text_delta" && idx >= 0) {
            (out.content[idx] as any).text += e.delta.text;
            stream.push({ type: "text_delta", contentIndex: idx, delta: e.delta.text, partial: out });
          } else if (e?.type === "content_block_stop" && idx >= 0) {
            stream.push({ type: "text_end", contentIndex: idx, content: (out.content[idx] as any).text, partial: out });
            idx = -1;
          } else if (e?.type === "message_start" && e.message?.usage) {
            out.usage.input = e.message.usage.input_tokens ?? 0;
            out.usage.cacheRead = e.message.usage.cache_read_input_tokens ?? 0;
            out.usage.cacheWrite = e.message.usage.cache_creation_input_tokens ?? 0;
          } else if (e?.type === "message_delta" && e.usage) out.usage.output = e.usage.output_tokens ?? out.usage.output;
        } else if (msg.type === "result") {
          if (msg.is_error || msg.subtype !== "success") err = typeof msg.result === "string" && msg.result ? msg.result : `sdk result ${msg.subtype}`;
          else final = msg.result ?? "";
        }
      }
      out.usage.totalTokens = out.usage.input + out.usage.output + out.usage.cacheRead + out.usage.cacheWrite;
      if (options?.signal?.aborted) { out.stopReason = "aborted"; out.errorMessage = "aborted"; stream.push({ type: "error", reason: "aborted", error: out }); }
      else if (err) { out.stopReason = "error"; out.errorMessage = err; stream.push({ type: "error", reason: "error", error: out }); }
      else {
        if (!out.content.length && final) out.content.push({ type: "text", text: final }); // no stream events seen
        out.stopReason = "stop";
        stream.push({ type: "done", reason: "stop", message: out });
      }
    } catch (e) {
      out.stopReason = "error"; out.errorMessage = e instanceof Error ? e.message : String(e);
      stream.push({ type: "error", reason: "error", error: out });
    } finally { try { q?.close(); } catch {} stream.end(); }
  })();
  return stream;
}

export function claudeBridgeProvider() {
  const model = (id: string, name: string) => ({
    id, name, api: PROVIDER_ID, provider: PROVIDER_ID, baseUrl: PROVIDER_ID, input: ["text"] as ("text")[],
    reasoning: false, contextWindow: 200_000, maxTokens: 64_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  return createProvider({
    id: PROVIDER_ID,
    name: "Claude (subscription via Agent SDK)",
    // Keyless/ambient auth: resolve() always reports "configured"; the claude CLI child finds the OAuth login itself.
    auth: { apiKey: { name: "Claude Code OAuth login (ambient)", resolve: async () => ({ auth: { apiKey: "not-used" }, source: "claude-code-oauth" }) } },
    models: [model("claude-haiku-5-5", "Claude Haiku 5.5 (subscription)")],
    api: { stream: (m: any, c: any, o: any) => streamSimple(m, c, o), streamSimple: streamSimple as any },
  } as any);
}
