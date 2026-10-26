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
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { effortFor } from "../models.js";
import { LlmInfraError, OutputTruncatedError } from "./errors.js";
import { DEFAULT_MAX_TOKENS } from "../config.js";

export interface ClaudeAgentSdkAdapterOptions {
  /** Absolute path to the `claude` executable. Omit to let the SDK resolve it. */
  pathToClaudeCodeExecutable?: string;
  /** Replaces the lazily loaded SDK `query` (tests). */
  query?: QueryFn;
}

// Child-process env hardening, matching pi-claude-bridge: keep the one-shot call
// isolated from claude.ai MCP servers and auto-compaction.
const CC_CHILD_ENV = {
  ENABLE_CLAUDEAI_MCP_SERVERS: "0",
  DISABLE_AUTO_COMPACT: "1",
} as const;

/**
 * Env for the `claude` child. This adapter *is* the subscription transport, so
 * API credentials are removed: Claude Code prefers ANTHROPIC_API_KEY over the
 * OAuth login / CLAUDE_CODE_OAUTH_TOKEN, and VPS wolves carry the key for their
 * main agent — leaving it in would silently bill the API.
 */
export function claudeChildEnv(env: NodeJS.ProcessEnv = process.env, maxTokens?: number): NodeJS.ProcessEnv {
  const { ANTHROPIC_API_KEY: _key, ANTHROPIC_AUTH_TOKEN: _token, ...rest } = env;
  // The SDK has no max-output option; Claude Code reads this env var instead.
  return { ...rest, ...CC_CHILD_ENV, ...(maxTokens ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens) } : {}) };
}

/** Assistant-message `error` values (SDKAssistantMessageError) that mean the transport, not the item, failed. */
const INFRA_ASSISTANT_ERRORS = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "verification_required",
  "billing_error",
  "rate_limit",
  "overloaded",
  "server_error",
  "cloud_credential_error",
  "model_not_found",
]);

/** Result text the claude CLI emits for usage/rate limits and expired logins. */
const INFRA_RESULT_TEXT =
  /usage limit|hit your (session |weekly |usage )?limit|limit reached|limit will reset|rate.?limit|overloaded|\/login|oauth|token (has )?expired|invalid api key|authentication|credit balance|\b(401|403|429|500|502|503|529)\b/i;

/** True when a failed SDK result/assistant error is a transport problem (limits, auth, overload, 5xx). */
export function isSdkInfraFailure(info: { assistantError?: string; apiStatus?: number | null; text?: string }): boolean {
  if (info.assistantError && INFRA_ASSISTANT_ERRORS.has(info.assistantError)) return true;
  const s = info.apiStatus;
  if (typeof s === "number" && (s === 401 || s === 403 || s === 408 || s === 429 || s >= 500)) return true;
  return INFRA_RESULT_TEXT.test(info.text ?? "");
}

// Keep the extraction call hermetic: don't let Claude Code load CLAUDE.md /
// AGENTS.md on top of our prompt.
const CLAUDE_MD_EXCLUDES = ["**/CLAUDE.md", "**/AGENTS.md", "**/.claude/rules/**"];

export type QueryFn = (params: { prompt: string; options?: any }) => AsyncIterable<any> & {
  interrupt?: () => Promise<void>;
  close?: () => void;
};

let cachedQuery: QueryFn | null = null;

export async function loadQuery(): Promise<QueryFn> {
  if (cachedQuery) return cachedQuery;
  // Indirect specifier so TS doesn't statically require the module at build time.
  // Deployed extension bundles (<den>/extensions/<x>/index.js) have no
  // node_modules above them, so plain import() fails; fall back to anchors we
  // control: the harness' own location, NODE_PATH, cwd, and the global install.
  const specifier = SDK_SPECIFIER;
  let mod: any;
  try {
    mod = await import(specifier);
  } catch (err) {
    const found = findSdkUrl(specifier);
    if (!found) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `claude-agent-sdk provider selected but ${specifier} ` +
          `could not be loaded (${msg}). Tried: ${sdkAnchors().join(", ")}. ` +
          `Install it (npm i -g ${specifier}) or use transport: api.`
      );
    }
    console.warn(`[claude-agent-sdk] plain import failed; loading SDK from ${found}`);
    try {
      mod = await import(found);
    } catch (err2) {
      const first = err instanceof Error ? err.message : String(err);
      const second = err2 instanceof Error ? err2.message : String(err2);
      throw new Error(
        `claude-agent-sdk provider selected but ${specifier} ` +
          `was found at ${found} and failed to load (${second}); ` +
          `plain import had failed with (${first}).`
      );
    }
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

const SDK_SPECIFIER = "@anthropic-ai/claude-agent-sdk";

/** Inputs for {@link sdkAnchors}; defaults read the live process. */
export interface SdkAnchorSources {
  argv1?: string;
  nodePath?: string;
  cwd?: string;
  execPath?: string;
}

/**
 * Directories to resolve the SDK from, in order: the entry script's tree
 * (harness.cjs → agent/node_modules; in dev only, the repo's packages/harness/dist),
 * NODE_PATH parents, the pinned global install, and cwd LAST (arbitrary, so it
 * must never beat the pinned global). The SDK can't be bundled (it spawns a
 * platform-native `claude` binary shipped as optional deps), so it is resolved
 * from the host.
 */
export function sdkAnchors(src: SdkAnchorSources = {}): string[] {
  const out: string[] = [];
  const add = (d: string | undefined) => { if (d && !out.includes(d)) out.push(d); };
  const entry = "argv1" in src ? src.argv1 : process.argv[1];
  if (entry) {
    try { add(path.dirname(realpathSync(entry))); } catch { add(path.dirname(entry)); }
  }
  for (const d of (src.nodePath ?? process.env.NODE_PATH ?? "").split(path.delimiter)) {
    // NODE_PATH entries are node_modules dirs; anchor one level up.
    if (d) add(path.dirname(d));
  }
  add(path.join(path.dirname(src.execPath ?? process.execPath), "..", "lib"));
  add(src.cwd ?? process.cwd());
  return out;
}

/** file:// URL of the SDK resolved from the first anchor that has it. */
export function findSdkUrl(specifier: string, anchors: string[] = sdkAnchors()): string | undefined {
  for (const anchor of anchors) {
    try {
      const resolved = createRequire(path.join(anchor, "noop.js")).resolve(specifier);
      return pathToFileURL(resolved).href;
    } catch {
      // try next anchor
    }
  }
  return undefined;
}

export class ClaudeAgentSdkAdapter implements KnowledgeAdapter {
  private pathToClaudeCodeExecutable?: string;
  private injectedQuery?: QueryFn;

  constructor(options: ClaudeAgentSdkAdapterOptions = {}) {
    this.injectedQuery = options.query;
    this.pathToClaudeCodeExecutable = options.pathToClaudeCodeExecutable;
  }

  async extract<T>(
    schema: z.ZodType<T>,
    options: ExtractOptions
  ): Promise<{ data: T; usage: UsageRecord }> {
    const query = this.injectedQuery ?? (await loadQuery());
    const maxRetries = options.maxRetries ?? 2;
    const systemWithSchema = buildSystemWithSchema(options.system, schema);

    let lastError: Error | null = null;
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let totalCost = 0;

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

      const {
        text, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd,
        resultError, infraFailure, truncated,
      } = await this.runQuery(query, systemWithSchema, prompt, options);

      totalInput += inputTokens;
      totalOutput += outputTokens;
      totalCacheRead += cacheReadTokens;
      totalCacheWrite += cacheWriteTokens;
      totalCost += costUsd;

      if (truncated) {
        throw new OutputTruncatedError(options.model, options.maxTokens ?? DEFAULT_MAX_TOKENS, text.length);
      }

      if (resultError && infraFailure) {
        // Usage/rate limit, auth, overload: retrying now only burns the limit.
        throw new LlmInfraError(`claude-agent-sdk: ${resultError}`);
      }

      if (resultError) {
        // Task failure (error_max_turns etc.) — retried, then fails as an item error.
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
            cacheReadTokens: totalCacheRead,
            cacheWriteTokens: totalCacheWrite,
            costUsd: totalCost,
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
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
    resultError?: string;
    infraFailure?: boolean;
    truncated?: boolean;
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
        env: claudeChildEnv(process.env, options.maxTokens),
        // A plain string systemPrompt is a *custom* prompt — no coding-agent
        // preset, which is what we want for pure extraction.
        systemPrompt,
        model: options.model,
        ...sdkThinkingOptions(options.thinking),
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
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let costUsd = 0;
    let assistantError: string | undefined;
    let apiStatus: number | null | undefined;
    let truncated = false;

    try {
    for await (const message of sdkQuery) {
      if (message.type === "assistant") {
        if (typeof message.error === "string") assistantError = message.error;
        if (message.error === "max_output_tokens" || message.message?.stop_reason === "max_tokens") truncated = true;
        for (const block of message.message?.content ?? []) {
          if (block.type === "text" && typeof block.text === "string") {
            assistantText += block.text;
          }
        }
      } else if (message.type === "result") {
        const usage = message.usage ?? {};
        inputTokens = usage.input_tokens ?? 0;
        outputTokens = usage.output_tokens ?? 0;
        cacheReadTokens = usage.cache_read_input_tokens ?? 0;
        cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
        // API-equivalent cost Claude Code computes (notional on a subscription).
        costUsd = typeof message.total_cost_usd === "number" ? message.total_cost_usd : 0;
        if (message.stop_reason === "max_tokens") truncated = true;
        apiStatus = message.api_error_status;
        // The CLI reports API failures (usage limit, 401, overload) as is_error
        // results, often with subtype "success" and the error text as `result`.
        if (message.subtype === "success" && !message.is_error) {
          finalText = message.result || assistantText;
        } else {
          const errs = Array.isArray(message.errors) ? message.errors.join("; ") : message.errors;
          resultError =
            message.result ||
            errs ||
            `claude-agent-sdk query failed (${message.subtype ?? "unknown"})`;
        }
      }
    }
    } catch (err) {
      // Aborts propagate untouched; anything else from the child (spawn failure,
      // exit code, broken pipe) is the transport failing.
      if (options.signal?.aborted) throw err;
      throw err instanceof LlmInfraError
        ? err
        : new LlmInfraError(`claude-agent-sdk: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
    options.signal?.throwIfAborted();

    return {
      text: finalText || assistantText,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      costUsd,
      resultError,
      truncated,
      infraFailure: resultError
        ? isSdkInfraFailure({ assistantError, apiStatus, text: String(resultError) })
        : undefined,
    };
  }
}

/** Thinking → Agent SDK options: `off` disables it; a level is adaptive thinking at that effort. */
export function sdkThinkingOptions(level: ExtractOptions["thinking"]): Record<string, unknown> {
  if (!level) return {};
  if (level === "off") return { thinking: { type: "disabled" } };
  return { thinking: { type: "adaptive" }, effort: effortFor(level) };
}

