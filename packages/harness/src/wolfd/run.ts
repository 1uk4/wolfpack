/**
 * startWolf: boot ONE wolf process serving /v1 on 127.0.0.1.
 *
 * Sequence: load wolf.yaml -> sandbox redirect -> resolve the main-tier model (WOLFPACK_MODELS_FILE / models.json beside the wolf /
 * pack config; subscription transport builds the claude-bridge provider) -> wolf.yaml `extensions` via the harness loader
 * (same as createWolfHarness, on the redirected den/env) -> open the engine store at `<den>/session.sqlite` (backup on) ->
 * root conversation (= the home thread; feature threads are further ownerless conversations) -> bring its agent state in line with config + project context ->
 * attach the server's watcher -> engine.resume() -> listen.
 *
 * Listener precedence here (library): socket option > port option > serve.port > ephemeral TCP. (The wolfd bin
 * resolves flags + config into these options; see bin/wolfd.ts.)
 * Agent state is only rewritten when it differs from what config + context say (configure appends a history entry).
 * Tier switching via configure is not wired yet (main tier only).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Models } from "@earendil-works/pi-ai/models";
import type { Extension } from "@earendil-works/pi-durable";
import { applyWolfTierOverrides, assertSandboxed, loadModelTable, type ModelTable, loadWolfConfig, resolveWolfModel, type WolfConfig } from "@wolfpack/engine";
import {
  objectsExtension,
  openWolfEngine,
  createCardGuardExtension,
  resolveToolNames,
  ReadOnlyTools,
  readOnlyToolsExcluding,
  type ConfigureOptions,
  type EngineConversation,
  type ThinkingLevel,
  type WolfEngine,
} from "../engine/index.js";
import { resolveWorkspacesRoot } from "@wolfpack/workspaces";
import { parse as parseYaml } from "yaml";
import { adaptToDurable } from "../adapters/durable.js";
import { createAskUserQuestionExtension } from "../extensions/ask-user-question.js";
import { loadExtensions, reportLoad, withoutProvided } from "../loader.js";
import { composeProjectContext } from "./context.js";
import { buildWolfModels } from "./models.js";
import { WolfServer } from "./server.js";
import { SubagentBridge, createSubagentExtension } from "./subagent-tools.js";
import { startLibrarianSweep, startSweepTimer } from "../sweep-host.js";
import type { SweepManager, SweepWorkerConfig } from "../sweep-worker.js";
import type { KbRoots } from "@wolfpack/kb/shared";
import { patchProcessEnv, startSandbox, type RunningSandbox, type StartWorkServer } from "./sandbox.js";
import { prepareSocketPath } from "./socket.js";
import { loadThreads, setThreadWorkspace } from "./threads.js";

export interface StartWolfOptions {
  /** Path to wolf.yaml. */
  configPath: string;
  /** Overrides serve.port. 0 = ephemeral. */
  port?: number;
  /** Listen on this unix socket instead of TCP (wins over port). */
  socket?: string;
  env?: NodeJS.ProcessEnv;
  /** Upper bound of the AGENTS.md/CLAUDE.md walk. Default: os.homedir(). */
  home?: string;
  log?: (line: string) => void;
  /** @internal test seam: replaces the model registry derived from the transport (e.g. a scripted provider). */
  models?: Models;
  /**
   * @internal test seam: extra engine extensions installed beside the configured tools (e.g. generation hooks).
   * Additive, except that one named like a configured wolf.yaml extension (`wolfpack-memory`) replaces it.
   * A function receives the wolf's effective den and env (sandbox redirect already applied) so extensions that
   * read them at construction see the sandbox, not the live roots.
   */
  extraExtensions?: readonly Extension[] | ((rt: ExtensionRuntime) => readonly Extension[]);
  /** @internal test seam: how the sandbox's local Work server is started (default: @wolfpack/agent). */
  startWorkServer?: StartWorkServer;
  /** @internal test seam: replaces the librarian sweep's tick (see SweepWorkerConfig.sweepTick). */
  sweepTick?: SweepWorkerConfig["sweepTick"];
}

export interface ExtensionRuntime {
  config: WolfConfig;
  den: string;
  env: NodeJS.ProcessEnv;
  sandbox?: RunningSandbox;
  /** Register a card-raising tool with this wolf's card guard (pass to adaptToDurable as `onCardTool`). */
  onCardTool: (name: string) => void;
}

export interface RunningWolf {
  url: string;
  config: WolfConfig;
  engine: WolfEngine;
  server: WolfServer;
  conversation: EngineConversation;
  /** The KB roots the server was given (KB_BASE + KB_OPS of the effective env); unset when the wolf has none. */
  kbRoots?: KbRoots;
  /** Set when wolf.yaml has `sandbox`: the redirect in force and the local Work server behind WORK_ENDPOINT. */
  sandbox?: RunningSandbox;
  close(): Promise<void>;
}

export async function startWolf(opts: StartWolfOptions): Promise<RunningWolf> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => {});
  const loaded = loadWolfConfig(opts.configPath);
  for (const w of loaded.warnings) log(`warning: ${w}`);

  // Sandbox first: it decides the den every later step opens. Refuses to start (before any store is touched) if
  // the dev root is not a snapshot or anything outward still resolves outside it.
  let sandbox: RunningSandbox | undefined;
  let config = loaded.config;
  if (config.sandbox) {
    sandbox = await startSandbox(config.sandbox.root, { startWorkServer: opts.startWorkServer, librarian: config.memory.librarian, wolf: config.identity.name });
    config = { ...config, den: sandbox.resolved.den };
    log(`sandbox: den=${config.den} KB_OPS=${sandbox.resolved.kbOps} WORK_ENDPOINT=${sandbox.resolved.workEndpoint}`);
  }
  // Extensions get the sandbox env through ExtensionRuntime/context.env. Only when the caller uses the process's
  // own env is process.env also patched, as a fallback for code that reads it directly (restored on close).
  // One sandboxed wolf per process (startSandbox enforces it).
  const restoreEnv = sandbox && !opts.env ? patchProcessEnv(sandbox.env) : () => {};
  try {
    return await startConfigured(opts, config, sandbox ? { ...env, ...sandbox.env } : env, log, sandbox, restoreEnv);
  } catch (e) {
    restoreEnv();
    await sandbox?.close().catch(() => {});
    throw e;
  }
}

async function startConfigured(
  opts: StartWolfOptions,
  config: WolfConfig,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
  sandbox: RunningSandbox | undefined,
  restoreEnv: () => void,
): Promise<RunningWolf> {
  if (config.sandbox) assertSandboxed(config.sandbox.root, { den: config.den, ...(sandbox ? { kbOps: sandbox.resolved.kbOps, kbDenLocal: sandbox.resolved.kbDenLocal, kbBase: env.KB_BASE, workEndpoint: sandbox.resolved.workEndpoint } : {}) });

  const { table: fileTable } = loadModelTable({ env, wolfYaml: config.file });
  // The wolf's table: models file + wolf.yaml `tiers:`. Handed to extensions so memory's engine steps use the same models.
  const table = applyWolfTierOverrides(fileTable, config);
  const model = resolveWolfModel(config, "main", table);
  const { extensions: toolExtensions, tools } = resolveToolNames(config.capability.tools);
  const cardGuard = createCardGuardExtension();
  const extra = typeof opts.extraExtensions === "function" ? opts.extraExtensions({ config, den: config.den, env, onCardTool: cardGuard.register, ...(sandbox ? { sandbox } : {}) }) : (opts.extraExtensions ?? []);
  // The wolf's configured extensions, through the same loader createWolfHarness uses. This runs AFTER the sandbox
  // redirect (config.den and env are the sandbox's) and the assertSandboxed gate above, so the extensions' own
  // fail-closed gates (memoryGate) see the effective den/env.
  // A librarian wolf's sweep (kb_sweep_* tools + the timer below), built from the same KB roots the memory extension
  // uses: KB_BASE/KB_OPS from the effective env (a sandbox KB copy), den-local state under the wolf's den.
  const kbRoots = kbRootsFor(config, env);
  const sweep = config.memory.librarian ? librarianSweepFor(config, env, table, log, opts.sweepTick) : undefined;
  const loaded = await loadConfiguredExtensions(config, env, table, extra, log, sweep, cardGuard.register);
  const askExt = createAskUserQuestionExtension();
  const ask = adaptToDurable(askExt, { wolfDen: config.den, wolfName: config.identity.name, onCardTool: cardGuard.register });
  // The card guard ends a whole round that contains a card-raising call (see engine/cards.ts). Tools adapted through
  // adaptToDurable register themselves via onCardTool; native pi-durable extensions that bypass the adapter must pass
  // their card tools explicitly (createCardGuardExtension([...names]) / cardGuard.register).
  // The spawn tools (subagent, subagent_message, subagents_list, subagent_stop): offered to home and feature threads only;
  // a child's conversation is configured with an explicit tool list that leaves them out.
  const subagentBridge = new SubagentBridge();
  const subagentExtensions = createSubagentExtension(subagentBridge, { wolfDen: config.den, wolfName: config.identity.name, onCardTool: cardGuard.register });
  // ls/grep/find/guarded_bash are always installed so subagent profiles can list them; the home and feature threads
  // only get them when wolf.yaml `tools:` names "readonly" (the terminal pi does not enable them by default either).
  // A tool another extension already defines keeps that definition.
  const readonlyOptIn = config.capability.tools.includes("readonly");
  const others = [...toolExtensions.filter((e) => e !== ReadOnlyTools), objectsExtension, ask, cardGuard.extension, ...subagentExtensions, ...loaded, ...extra];
  const taken = new Set(others.flatMap((e) => (e.tools ?? []).map((t) => t.name)));
  const readonlyExt = readOnlyToolsExcluding(taken, (m) => log(`warning: ${m}`));
  const ownReadonly = new Set((readonlyExt?.tools ?? []).map((t) => t.name));
  const extensions = [...(readonlyExt ? [readonlyExt] : []), ...others];
  const cwd = config.capability.workspace;
  // `prompts?.` is defensive: a stale engine dist predates the field and would crash wolfd boot.
  const contextFor = (at: string) => composeProjectContext({ name: config.identity.name, domains: config.identity.domains, cwd: at, den: config.den, home: opts.home, ...(config.prompts?.structuredOutput !== undefined ? { structuredOutput: config.prompts?.structuredOutput } : {}) });
  const context = contextFor(cwd);

  // Refuse before touching the store: a second wolfd on a live wolf's den would double-open its sqlite.
  if (opts.socket) await prepareSocketPath(opts.socket);

  mkdirSync(config.den, { recursive: true });
  const wolfModels = opts.models ? { models: opts.models, shutdown: () => {} } : buildWolfModels(model, { cwd, env });
  const engine = await openWolfEngine(join(config.den, "session.sqlite"), {
    ...(wolfModels.models ? { models: wolfModels.models } : {}),
    extensions,
    cwd,
    backup: true,
    onReport: (e) => log(`engine report: ${e instanceof Error ? e.message : String(e)}`),
  });
  if (engine.backup) log(`backed up session store to ${engine.backup.dir}`);

  try {
    const desired: ConfigureOptions = {
      model: { provider: model.provider, modelId: model.modelId },
      ...(model.thinking ? { thinkingLevel: model.thinking as ThinkingLevel } : {}),
      tools: withExtensionTools(tools, engine.toolNames()).filter((t) => readonlyOptIn || !ownReadonly.has(t)),
      cwd,
      instructions: context.instructions,
    };
    const conversation = await engine.conversations.root(desired);
    await reconcile(conversation, desired);

    const server = new WolfServer({
      name: config.identity.name,
      conversation,
      // Feature threads: fresh ownerless conversations configured like home (reconciled again when reopened).
      conversations: {
        create: () => engine.conversations.create(desired),
        get: async (id) => {
          const conv = await engine.conversations.get(id);
          // A feature thread whose workspace was created keeps its cwd there (home's would move it back).
          const saved = loadThreads(config.den).find((t) => t.conversationId === id);
          let workspace = saved?.workspace;
          if (saved && workspace && !existsSync(workspace.path)) {
            // The worktree was removed behind our back: back to the wolf's workspace, and say so.
            log(`server error: thread ${saved.id}: feature workspace ${workspace.path} is gone; its cwd falls back to ${cwd}`);
            setThreadWorkspace(config.den, saved.id, undefined);
            workspace = undefined;
          }
          if (conv) await reconcile(conv, workspace ? { ...desired, cwd: workspace.path, instructions: contextFor(workspace.path).instructions } : desired);
          return conv;
        },
      },
      den: config.den,
      subagents: {
        bridge: subagentBridge,
        wolfHome: dirname(config.file),
        workspace: cwd,
        instructionsFor: (at) => contextFor(at).instructions,
        workspacesRoot: resolveWorkspacesRoot(dirname(config.file), readWorkspacesConfig(config.file)),
        ...(config.subagents?.maxRunning !== undefined ? { maxRunning: config.subagents.maxRunning } : {}),
        // Per-host cap and slot directory: shared by every wolfd on the host (env WOLFPACK_SUBAGENT_HOST_MAX / _SLOTS).
        ...(Number(env.WOLFPACK_SUBAGENT_HOST_MAX) >= 1 ? { hostMax: Number(env.WOLFPACK_SUBAGENT_HOST_MAX) } : {}),
        ...(Number(env.WOLFPACK_SUBAGENT_SLOT_POLL_MS) > 0 ? { slotPollMs: Number(env.WOLFPACK_SUBAGENT_SLOT_POLL_MS) } : {}),
        slotDir: env.WOLFPACK_SUBAGENT_SLOTS || join(opts.home ?? homedir(), ".wolfpack", "run", "subagent-slots"),
        getConversation: (id) => engine.conversations.get(id),
        releaseOwner: (taskId) => engine.conversations.releaseOwner(taskId),
        createOwned: (ownerId, init) => engine.conversations.createOwned(ownerId, { ...desired, ...init }),
        resolveTier: (tier) => {
          const m = resolveWolfModel(config, tier, table);
          return { provider: m.provider, modelId: m.modelId, ...(m.thinking ? { thinking: m.thinking } : {}) };
        },
        registeredTools: () => engine.toolNames(),
      },
      memoryExtension: memoryExtensionInstalled(extensions),
      librarian: config.memory.librarian,
      ...(kbRoots ? { kbRoots } : {}),
      memoryConfig: {
        sandbox: !!config.sandbox,
        disabled: config.extensionConfig.memory?.enabled === false,
        consolidation: { threshold: config.memory.consolidation.threshold, poolTarget: config.memory.consolidation.poolTarget, trigger: config.memory.consolidation.trigger },
      },
      work: { endpoint: env.WORK_ENDPOINT, token: env.WORK_TOKEN },
      onError: (e) => log(`server error: ${String(e)}`),
    });
    await server.attach();
    engine.resume();
    const url = opts.socket ? await server.listenSocket(opts.socket) : await server.listen(opts.port ?? config.serve.port ?? 0);
    // Timer last, once the wolf serves: a librarian sweeps on its interval (default 1m), like the VPS harness.
    const sweepTimer = sweep ? startSweepTimer(sweep, config.memory.sweepInterval ?? "1m", log) : undefined;
    return {
      url,
      config,
      engine,
      server,
      conversation,
      ...(kbRoots ? { kbRoots } : {}),
      ...(sandbox ? { sandbox } : {}),
      close: async () => {
        if (sweepTimer) clearInterval(sweepTimer);
        await server.close();
        await engine.close();
        wolfModels.shutdown();
        await sandbox?.close();
        restoreEnv();
      },
    };
  } catch (e) {
    await engine.close().catch(() => {});
    wolfModels.shutdown();
    throw e;
  }
}

/**
 * Load wolf.yaml `extensions` via the harness loader (`<den>/extensions/<name>/index.js`, wolfpack-memory included).
 * `extra` REPLACES a configured extension of the same name (it is not loaded at all), so tests that inject their own
 * memory extension never get a second observer, consolidation timer or set of routes.
 * wolfd has no host timer, so the memory extension's own consolidation timer is the one timer; the engine attaches the
 * one conversation reader.
 * Nothing is started here: the memory factory only builds closures (its timer starts lazily on the first observation
 * and stops with the engine), so a later extension failing leaves nothing running to tear down; startWolf's catch
 * restores the env and closes the sandbox.
 * A missing extension is a warning (as in createWolfHarness); one that is present but fails to build (a gate refusing
 * a misconfigured sandbox, a broken bundle) refuses to start the wolf rather than booting quietly without it.
 */
async function loadConfiguredExtensions(config: WolfConfig, env: NodeJS.ProcessEnv, modelTable: ModelTable, extra: readonly Extension[], log: (line: string) => void, sweep?: SweepManager, onCardTool?: (name: string) => void): Promise<Extension[]> {
  const names = withoutProvided(config.extensions, extra);
  if (names.length === 0) return [];
  const blocks: Record<string, unknown> = { ...config.extensionConfig };
  if (names.includes("memory")) blocks.memory = { ...config.extensionConfig.memory, ...config.memory };
  const result = await loadExtensions(names, {
    wolfDen: config.den,
    wolfName: config.identity.name,
    domains: config.identity.domains,
    runtime: "pi-durable",
    wolfConfig: { name: config.identity.name, domains: config.identity.domains, ...blocks, ...(config.sandbox ? { sandbox: config.sandbox } : {}) },
    env,
    modelTable,
    ...(onCardTool ? { onCardTool } : {}),
    workspace: config.capability.workspace,
    // wolfd always installs the card-raising ask_user_question (see startWolf).
    capabilities: { askCards: true },
    ...(sweep ? { sweep } : {}),
  });
  reportLoad(result, { info: log, warn: (l) => log(`warning: ${l}`) });
  const broken = result.failed.filter((f) => !f.notFound);
  if (broken.length > 0) throw new Error(`extension ${broken.map((f) => `${f.name}: ${f.error}`).join("; ")}`);
  return result.extensions;
}

/** The KB roots the memory extension promotes into (and the KB routes read): KB_BASE + KB_OPS from the effective env. */
function kbRootsFor(config: WolfConfig, env: NodeJS.ProcessEnv): KbRoots | undefined {
  if (!env.KB_BASE || !env.KB_OPS) return undefined;
  return { kbBase: env.KB_BASE, opsRoot: env.KB_OPS, denLocal: env.KB_DEN_LOCAL ?? join(config.den, "kb") };
}

function librarianSweepFor(config: WolfConfig, env: NodeJS.ProcessEnv, table: ModelTable, log: (line: string) => void, sweepTick?: SweepWorkerConfig["sweepTick"]): SweepManager {
  if (!env.KB_BASE || !env.KB_OPS) throw new Error(`${config.identity.name}: memory.librarian needs KB_BASE and KB_OPS (a sandbox with a KB copy provides them)`);
  const roots: KbRoots = { kbBase: env.KB_BASE, opsRoot: env.KB_OPS, denLocal: join(config.den, "kb") };
  return startLibrarianSweep({ roots, table, env, log, events: { den: config.den, wolf: config.identity.name }, ...(sweepTick ? { sweepTick } : {}) });
}

/** Is the memory extension among what was installed (configured, or injected by a test)? */
function memoryExtensionInstalled(installed: readonly Extension[]): boolean {
  return installed.some((e) => e.name === "wolfpack-memory");
}

/**
 * The conversation's active tool list: the wolf.yaml `tools:` names plus every tool the loaded extensions register
 * (task_bind, memory tools, ...). createWolfHarness passes no selection, so pi-durable offers it the whole registry;
 * wolfd selects by name, so it must name the extension tools too or the model is never offered them.
 */
export function withExtensionTools(configured: readonly string[], registered: readonly string[]): string[] {
  return [...new Set([...configured, ...registered])].sort();
}

/** `root(init)` only applies at creation; on later starts configure when stored state differs from desired. */
async function reconcile(conv: EngineConversation, want: ConfigureOptions): Promise<void> {
  const w = await conv.watch();
  const have = w.snapshot.agent;
  await w.stop();
  const haveTools = Array.isArray(have.tools) ? have.tools : undefined;
  const sameTools = haveTools !== undefined && want.tools !== undefined && haveTools.length === want.tools.length && want.tools.every((t, i) => haveTools[i] === t);
  const same =
    have.model?.provider === want.model?.provider &&
    have.model?.modelId === want.model?.modelId &&
    have.cwd === want.cwd &&
    have.instructions === want.instructions &&
    (have.thinkingLevel ?? undefined) === (want.thinkingLevel ?? undefined) &&
    sameTools;
  if (!same) await conv.configure(want);
}

/** The `workspaces:` block of wolf.yaml (its root); the engine's config loader does not model it. */
function readWorkspacesConfig(file: string): { workspaces?: { root?: string } } | null {
  try {
    const doc = parseYaml(readFileSync(file, "utf8")) as { workspaces?: { root?: unknown } } | null;
    return typeof doc?.workspaces?.root === "string" ? { workspaces: { root: doc.workspaces.root } } : null;
  } catch {
    return null;
  }
}
