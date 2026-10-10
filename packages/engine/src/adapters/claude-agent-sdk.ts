/**
 * Claude Agent SDK adapter — routes structured-extraction calls through the
 * local `claude` binary (`@anthropic-ai/claude-agent-sdk`) instead of the raw
 * Anthropic API.
 *
 * Why: the Agent SDK authenticates with the user's Claude subscription (MAX/Pro
 * OAuth), so memory consolidation and KB work run on the subscription with no
 * `ANTHROPIC_API_KEY` and no per-token billing. It is the same transport the
 * `pi-claude-bridge` provider uses for the interactive session.
 *
 * Strategy mirrors the Anthropic adapter: prompt for raw JSON, parse, validate
 * against the Zod schema, and retry with the validation error on failure. Each
 * call is a one-shot, tool-less, non-persisted `query()` (maxTurns: 1).
 *
 * The SDK is imported lazily (and via an indirect specifier) so this package
 * builds and loads even in environments where the Agent SDK isn't installed —
 * only actually calling `extract()` requires it.
 */
import type { z } from "zod";
import type {
  KnowledgeAdapter,
  ExtractOptions,
  UsageRecord,
} from "../adapter.js";
import { buildSystemWithSchema, extractJSON } from "./json-extract.js";

export interface ClaudeAgentSdkAdapterOptions {
  /** Absolute path to the `claude` executable. Omit to let the SDK resolve it. */
  pathToClaudeCodeExecutable?: string;
}

// Child-process env hardening, matching pi-claude-bridge: keep the one-shot call
// isolated from claude.ai MCP servers and auto-compaction.
const CC_CHILD_ENV = {
  ENABLE_CLAUDEAI_MCP_SERVERS: "0",
  DISABLE_AUTO_COMPACT: "1",
} as const;

// Keep the extraction call hermetic: don't let Claude Code load CLAUDE.md /
// AGENTS.md on top of our prompt.
const CLAUDE_MD_EXCLUDES = ["**/CLAUDE.md", "**/AGENTS.md", "**/.claude/rules/**"];

type QueryFn = (params: { prompt: string; options?: any }) => AsyncIterable<any> & {
  interrupt?: () => Promise<void>;
  close?: () => void;
};

let cachedQuery: QueryFn | null = null;

async function loadQuery(): Promise<QueryFn> {
  if (cachedQuery) return cachedQuery;
  // Indirect specifier so TS doesn't statically require the module at build time;
  // it is resolved from node_modules at runtime.
  const specifier = "@anthropic-ai/claude-agent-sdk";
  let mod: any;
  try {
    mod = await import(specifier);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `claude-agent-sdk provider selected but @anthropic-ai/claude-agent-sdk ` +
        `could not be loaded (${msg}). Install it or set a different provider.`
    );
  }
  const query = mod.query ?? mod.default?.query;
  if (typeof query !== "function") {
    throw new Error(
      "@anthropic-ai/claude-agent-sdk loaded but did not export query()."
    );
  }
  cachedQuery = query as QueryFn;
  return cachedQuery;
}

export class ClaudeAgentSdkAdapter implements KnowledgeAdapter {
  private pathToClaudeCodeExecutable?: string;

  constructor(options: ClaudeAgentSdkAdapterOptions = {}) {
    this.pathToClaudeCodeExecutable = options.pathToClaudeCodeExecutable;
  }

  async extract<T>(
    schema: z.ZodType<T>,
    options: ExtractOptions
  ): Promise<{ data: T; usage: UsageRecord }> {
    const query = await loadQuery();
    const maxRetries = options.maxRetries ?? 2;
    const systemWithSchema = buildSystemWithSchema(options.system, schema);

    let lastError: Error | null = null;
    let totalInput = 0;
    let totalOutput = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      options.signal?.throwIfAborted();
      const prompt =
        attempt === 0
          ? options.prompt
          : [
              options.prompt,
              "",
              "Your previous response did not match the required schema.",
              "Validation error:",
              lastError?.message ?? "Unknown error",
              "",
              "Please try again. Respond with valid JSON only.",
            ].join("\n");

      const { text, inputTokens, outputTokens, resultError } =
        await this.runQuery(query, systemWithSchema, prompt, options);

      totalInput += inputTokens;
      totalOutput += outputTokens;

      if (resultError) {
        // Transport/model error (rate limit, overload, etc.) — surface it.
        lastError = new Error(resultError);
        continue;
      }

      const json = extractJSON(text);
      if (json === null) {
        lastError = new Error(
          `Could not extract JSON from response: ${text.slice(0, 200)}`
        );
        continue;
      }

      const result = schema.safeParse(json);
      if (result.success) {
        return {
          data: result.data,
          usage: {
            step: "", // Filled in by the caller
            model: options.model,
            inputTokens: totalInput,
            outputTokens: totalOutput,
            timestamp: new Date().toISOString(),
          },
        };
      }

      lastError = new Error(
        result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")
      );
    }

    throw new Error(
      `Failed to extract valid output after ${maxRetries + 1} attempts. ` +
        `Last error: ${lastError?.message}`
    );
  }

  private async runQuery(
    query: QueryFn,
    systemPrompt: string,
    prompt: string,
    options: ExtractOptions
  ): Promise<{
    text: string;
    inputTokens: number;
    outputTokens: number;
    resultError?: string;
  }> {
    // Tie the SDK's own controller to the caller's signal, so aborting stops
    // the claude subprocess rather than leaving it running.
    const abortController = new AbortController();
    const onAbort = () => abortController.abort(options.signal?.reason);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });

    const sdkQuery = query({
      prompt,
      options: {
        abortController,
        cwd: process.cwd(),
        env: { ...process.env, ...CC_CHILD_ENV },
        // A plain string systemPrompt is a *custom* prompt — no coding-agent
        // preset, which is what we want for pure extraction.
        systemPrompt,
        model: options.model,
        maxTurns: 1,
        tools: [],
        skills: [],
        strictMcpConfig: true,
        persistSession: false,
        settingSources: [],
        settings: { autoMemoryEnabled: false, claudeMdExcludes: CLAUDE_MD_EXCLUDES },
        ...(this.pathToClaudeCodeExecutable
          ? { pathToClaudeCodeExecutable: this.pathToClaudeCodeExecutable }
          : {}),
      },
    });

    let assistantText = "";
    let finalText = "";
    let resultError: string | undefined;
    let inputTokens = 0;
    let outputTokens = 0;

    try {
    for await (const message of sdkQuery) {
      if (message.type === "assistant") {
        for (const block of message.message?.content ?? []) {
          if (block.type === "text" && typeof block.text === "string") {
            assistantText += block.text;
          }
        }
      } else if (message.type === "result") {
        const usage = message.usage ?? {};
        inputTokens = usage.input_tokens ?? 0;
        outputTokens = usage.output_tokens ?? 0;
        if (message.subtype === "success") {
          finalText = message.result || assistantText;
        } else {
          resultError =
            message.result ||
            message.errors ||
            `claude-agent-sdk query failed (${message.subtype ?? "unknown"})`;
        }
      }
    }
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
    options.signal?.throwIfAborted();

    return {
      text: finalText || assistantText,
      inputTokens,
      outputTokens,
      resultError,
    };
  }
}
