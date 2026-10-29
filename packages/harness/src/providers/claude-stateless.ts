/**
 * The ONLY other file in the harness that knows about the stateless pi-claude-bridge (a grep test enforces it).
 * Same Max-subscription transport as claude-bridge, but each model round is one short-lived Agent SDK query over a
 * resumable session file (no parked child). Provider id `claude-stateless`; it sits next to `claude-bridge`.
 *
 * ROLLOUT NOTE: the dependency `pi-claude-bridge-stateless` in packages/harness/package.json is a LOCAL git ref
 * (git+file:///…/workspaces/pi-claude-bridge#stateless-core, pinned by commit in the lockfile; npm builds dist via the
 * fork's `prepare`). It works on this machine only: it MUST become a pushed `github:` ref before any VPS deploy.
 *
 * Paths: STATE DIR, not the den. The den is Syncthing-synced on VPS wolves (add-wolf.sh installs a `.stignore` there) and
 * holds the knowledge/backups, and session files are transcripts plus a debug log: keep them out. The state dir is
 * `<dirname(WOLF_DEN)>/claude-stateless/<basename(WOLF_DEN)>` (the wolf home next to the den: it also holds .env, logs/,
 * agent/ and is not synced). WOLF_DEN is set by wolfd; with it unset the factory throws (never guess a cwd: it could
 * be a project repo).
 *   sessions  <state>/sessions   (the fixed CLI cwd and the one folder holding every session file)
 *   debug log <state>/debug.log  (JSON lines, on by default; CLAUDE_BRIDGE_DEBUG_PATH is NOT consulted)
 *
 * ASSUMPTION (pinned by claude-stateless.test.ts): nothing on the stateless entry path calls the bridge's skills.ts
 * renderSkillsBlock → formatSkillsForPrompt. The CLI bundle stubs @earendil-works/pi-coding-agent for the bridge
 * (stubBridgeSdkPlugin), so a call would throw. If the bridge starts using it, drop the stub or bundle properly.
 * `forget(id)` deletes the session files of one conversation; `dispose()` kills in-flight queries.
 */
import { createStatelessProvider } from "pi-claude-bridge-stateless/stateless";
import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
  const den = ctx.env.WOLF_DEN;
  if (!den) throw new Error("claude-stateless: WOLF_DEN is not set (wolfd sets it); refusing to put session files in the working directory");
  const root = join(dirname(den), CLAUDE_STATELESS_ID, basename(den));
  return { sessionDir: join(root, "sessions"), debugLogPath: join(root, "debug.log") };
};

export const claudeStatelessFactory: ProviderFactory = (ctx) => {
  const seams = (ctx.seams?.[CLAUDE_STATELESS_ID] ?? {}) as ClaudeStatelessSeams;
  const { sessionDir, debugLogPath } = claudeStatelessPaths(ctx);
  // The bridge does not create the CLI cwd: with a missing folder the first round fails with a misleading "native binary
  // failed to launch" (spawn ENOENT). Create it here (found in the live smoke test; report upstream).
  try { mkdirSync(sessionDir, { recursive: true }); } catch (e) { console.warn(`claude-stateless: cannot create ${sessionDir}: ${e instanceof Error ? e.message : String(e)}`); }
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
