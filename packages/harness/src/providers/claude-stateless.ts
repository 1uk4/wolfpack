/**
 * The ONLY other file in the harness that knows about the stateless pi-claude-bridge (a grep test enforces it).
 * Same Max-subscription transport as claude-bridge, but each model round is one short-lived Agent SDK query over a
 * resumable session file (no parked child). Provider id `claude-stateless`; it sits next to `claude-bridge`.
 *
 * ROLLOUT NOTE: the dependency `pi-claude-bridge-stateless` in packages/harness/package.json is a LOCAL path
 * (file:…/pi-claude-bridge, branch stateless-core). It MUST become a pushed git ref (github:1uk4/pi-claude-bridge#<ref>
 * or similar) before any VPS deploy.
 *
 * Paths (from the wolf den, env WOLF_DEN, which wolfd always sets; falls back to ctx.cwd):
 *   sessions  <den>/claude-stateless/sessions   (the fixed CLI cwd and the one folder holding every session file)
 *   debug log <den>/claude-stateless/debug.log  (JSON lines, on by default; CLAUDE_BRIDGE_DEBUG_PATH is NOT consulted)
 * `forget(id)` deletes the session files of one conversation; `dispose()` kills in-flight queries.
 */
import { createStatelessProvider } from "pi-claude-bridge-stateless/stateless";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { claudeBridgeLookupModels, NO_TOOL_SEARCH } from "./claude-bridge.js";
import { guardProviderStreams } from "./guard.js";
import type { ProviderFactory } from "./types.js";

export const CLAUDE_STATELESS_ID = "claude-stateless";

export interface ClaudeStatelessSeams {
  createProvider?: typeof createStatelessProvider;
  queryFn?: Parameters<typeof createStatelessProvider>[0]["queryFn"];
  /** Overrides the models (tests). */
  models?: Parameters<typeof createStatelessProvider>[0]["models"];
}

/** claude-bridge's model table re-tagged for this provider (same ids, limits and zero costs). */
export const claudeStatelessModels = (ctx: { cwd: string; env: NodeJS.ProcessEnv }) =>
  claudeBridgeLookupModels(ctx).map((m: any) => ({ ...m, api: CLAUDE_STATELESS_ID, provider: CLAUDE_STATELESS_ID, baseUrl: CLAUDE_STATELESS_ID }));

export const claudeStatelessPaths = (ctx: { cwd: string; env: NodeJS.ProcessEnv }) => {
  const root = join(ctx.env.WOLF_DEN || ctx.cwd, CLAUDE_STATELESS_ID);
  return { sessionDir: join(root, "sessions"), debugLogPath: join(root, "debug.log") };
};

export const claudeStatelessFactory: ProviderFactory = (ctx) => {
  const seams = (ctx.seams?.[CLAUDE_STATELESS_ID] ?? {}) as ClaudeStatelessSeams;
  const { sessionDir, debugLogPath } = claudeStatelessPaths(ctx);
  // The bridge does not create the CLI cwd: with a missing folder the first round fails with a misleading "native binary
  // failed to launch" (spawn ENOENT). Create it here (found in the live smoke test; report upstream).
  try { mkdirSync(sessionDir, { recursive: true }); } catch { /* the round reports the real error */ }
  const handle = (seams.createProvider ?? createStatelessProvider)({
    id: CLAUDE_STATELESS_ID,
    models: (seams.models ?? claudeStatelessModels(ctx)) as never,
    sessionDir,
    env: { ...ctx.env, ...NO_TOOL_SEARCH },
    debug: true,
    debugLogPath,
    ...(seams.queryFn ? { queryFn: seams.queryFn } : {}),
  });
  guardProviderStreams(handle.provider as never, { provider: CLAUDE_STATELESS_ID });
  return { provider: handle.provider as never, forget: (id) => void handle.forget(id), dispose: () => void handle.dispose() };
};
