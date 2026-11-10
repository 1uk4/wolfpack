/**
 * The ONLY other file in the harness that knows about the stateless pi-claude-bridge (a grep test enforces it).
 * Max-subscription transport (the default, replacing the retired pi-claude-bridge durable-core provider): each model round is one short-lived Agent SDK query over a
 * resumable session file (no parked child). Provider id `claude-stateless`.
 *
 * DEPENDENCY: `pi-claude-bridge-stateless` in packages/harness/package.json is a `git+https://github.com/1uk4/pi-claude-bridge.git#<commit>`
 * ref (the pushed `stateless-core` branch, pinned by commit in the lockfile; npm builds dist via the fork's `prepare`). Bumping
 * it means re-checking the seams below (lazySdkQuery) and the model policy.
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
import { loadQuery } from "@wolfpack/engine";
import { createStatelessProvider } from "pi-claude-bridge-stateless/stateless";
import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getModels } from "@earendil-works/pi-ai/compat";
import { guardProviderStreams } from "./guard.js";
import { withDroppedCallNet } from "./dropped-call.js";
import { withMaxTurnsAsTurnEnd } from "./max-turns.js";
import type { ProviderFactory } from "./types.js";

export const CLAUDE_STATELESS_ID = "claude-stateless";

/**
 * ENABLE_TOOL_SEARCH=false: the provider runs claude with `tools: []`, which removes ToolSearch, yet Claude Code still
 * defers MCP tool schemas behind it. The model would see task_bind etc. by name only. Inline every schema.
 */
export const NO_TOOL_SEARCH = { ENABLE_TOOL_SEARCH: "false" } as const;

/** Legacy provider id of the retired durable-core bridge: stored conversation refs and old models.json files still say it. */
export const LEGACY_CLAUDE_BRIDGE_ID = "claude-bridge";

// Model table policy (ONE_M = the bridge's MEASURED_ONE_M, FAMILY_ORDER, rank): a COPY of pi-claude-bridge-stateless's models.ts
// (the package exports only ./stateless, so it cannot be imported). KEEP IN SYNC with it when the bridge is bumped.
// Dropped on purpose: the bridge's PLAN_GATED_ONE_M (claude-opus-4-6, claude-sonnet-4-6): they are 200K here, not 1M.
const FAMILY_ORDER = ["fable", "opus", "sonnet", "haiku"];
const rank = (id: string) => { const [, family, major, minor] = id.split("-"); return { family, t: [Number(major) || 0, Number(minor) || 0] as const }; };
/** Ids Claude Code serves at 1M through the SDK; every other model is 200K. */
const ONE_M = new Set(["claude-fable-5", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);

/** pi-ai's anthropic catalog projected for the subscription: no dated aliases, newest first, zero cost, 1M only where measured. */
export const buildSubscriptionModels = (catalog: readonly any[]) =>
  catalog
    .filter((m) => typeof m.id === "string" && !/-20\d{6}$/.test(m.id))
    .sort((a, b) => {
      const fa = FAMILY_ORDER.indexOf(rank(a.id).family!), fb = FAMILY_ORDER.indexOf(rank(b.id).family!);
      const ta = fa === -1 ? FAMILY_ORDER.length : fa, tb = fb === -1 ? FAMILY_ORDER.length : fb;
      if (ta !== tb) return ta - tb;
      const ra = rank(a.id).t, rb = rank(b.id).t;
      return ra[0] !== rb[0] ? rb[0] - ra[0] : ra[1] !== rb[1] ? rb[1] - ra[1] : a.id.localeCompare(b.id);
    })
    .map(({ id, name, reasoning, input, maxTokens, thinkingLevelMap }) => {
      const oneM = ONE_M.has(id);
      return {
        id, name: oneM && !/\b1M\b/i.test(name) ? `${name} 1M` : name, reasoning, input,
        contextWindow: oneM ? 1_000_000 : 200_000, maxTokens, thinkingLevelMap,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
    });

export interface ClaudeStatelessSeams {
  createProvider?: typeof createStatelessProvider;
  queryFn?: Parameters<typeof createStatelessProvider>[0]["queryFn"];
  /** Overrides the models (tests). */
  models?: Parameters<typeof createStatelessProvider>[0]["models"];
}

/**
 * The bridge resumes a deterministic Claude session every round and sends `systemPrompt` (a plain string: plan.system).
 * The SDK's default for a bare string is `snapshot: true`: the first request's prompt is recorded and replayed verbatim on
 * every resume, so a changed persona (AGENTS.md) is ignored until compaction (sdk.d.ts, `systemPrompt`: "use
 * { type: 'custom', prompt, snapshot: false } to opt it out"). Wrap the query so the prompt is sent fresh every round:
 * string / string[] become a custom prompt, an object without `snapshot` gets `snapshot: false`; an explicit `snapshot`
 * and a missing prompt are left alone. Cost: the prompt is re-rendered per request (the cache prefix stays stable while
 * the text does; a persona edit costs one cache miss).
 */
export const withFreshSystemPrompt = (queryFn: (args: any) => any) => (args: any) => {
  const sp = args?.options?.systemPrompt;
  let next: unknown;
  if (typeof sp === "string" || Array.isArray(sp)) next = { type: "custom", prompt: sp, snapshot: false };
  else if (sp && typeof sp === "object" && sp.snapshot === undefined) next = { ...sp, snapshot: false };
  else return queryFn(args);
  return queryFn({ ...args, options: { ...args.options, systemPrompt: next } });
};

/**
 * The host's Agent SDK `query`, loaded lazily (the bridge's own SDK import is stubbed in the bundle, so the harness gets it
 * from the engine's loader, which is async). The bridge only iterates the result and calls close(), so a deferred
 * proxy is enough.
 */
export const lazySdkQuery = (load: () => Promise<(args: any) => any> = loadQuery as never) => (args: any) => {
  let real: any;
  let closed = false;
  const started = load().then((q) => { real = q(args); if (closed) real.close?.(); return real; });
  // A load failure with close() before anyone iterates would be an unhandled rejection (can crash wolfd). The failure
  // still reaches the iterator: `await started` below rethrows it.
  started.catch(() => {});
  // Only what pi-claude-bridge-stateless v0.9.3 uses (asyncIterator, close): a bridge upgrade needs a check here.
  return {
    async *[Symbol.asyncIterator]() {
      const q = await started;
      yield* q;
    },
    close: () => { closed = true; try { real?.close?.(); } catch { /* already gone */ } },
  };
};

/** Seams carrying the host's Agent SDK `query` (the bridge's own import is stubbed in the bundle). The factory wraps it with withFreshSystemPrompt; this only injects it. */
export const claudeStatelessSdkSeams = (queryFn: unknown): ClaudeStatelessSeams => ({
  queryFn: queryFn as ClaudeStatelessSeams["queryFn"],
});

/** The subscription model table tagged for a provider id (no network, no process). */
export const claudeStatelessModels = (_ctx?: { cwd: string; env: NodeJS.ProcessEnv }, id: string = CLAUDE_STATELESS_ID) =>
  buildSubscriptionModels(getModels("anthropic") as any[]).map((m) => ({ ...m, api: id, provider: id, baseUrl: id }));

/** Lookup list for stored `claude-bridge/<model>` refs (conversations written before the bridge was retired). */
export const legacyBridgeLookupModels = (ctx?: { cwd: string; env: NodeJS.ProcessEnv }) => claudeStatelessModels(ctx, LEGACY_CLAUDE_BRIDGE_ID);

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
    // Always wrapped, whoever builds the registry (wolfd passes no seams; the pi entry injects the host query).
    queryFn: withMaxTurnsAsTurnEnd(withFreshSystemPrompt((seams.queryFn ?? lazySdkQuery()) as (args: any) => any)) as never,
  });
  guardProviderStreams(handle.provider as never, { provider: CLAUDE_STATELESS_ID });
  // Logs the SDK's final message for a round the bridge dropped a tool call in (work-wolfpack-7g4ZFMJ).
  const p = handle.provider as any;
  // pi's agent loop calls streamSimple (compat.js streamSimple -> provider.streamSimple); stream() is the non-simple entry.
  // The bridge aliases both to one function today, but each is wrapped on its own so neither bypasses the net nor changes
  // the other's signature if the bridge ever splits them.
  p.stream = withDroppedCallNet(p.stream.bind(p));
  p.streamSimple = withDroppedCallNet(p.streamSimple.bind(p));
  return { provider: handle.provider as never, forget: (id) => void handle.forget(id), dispose: () => void handle.dispose() };
};
