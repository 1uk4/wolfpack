/**
 * startWolf: boot ONE wolf process serving /v1 on 127.0.0.1.
 *
 * Sequence: load wolf.yaml -> sandbox redirect -> resolve the main-tier model (WOLFPACK_MODELS_FILE / models.json beside the wolf /
 * pack config; subscription transport builds the claude-bridge provider) -> wolf.yaml `extensions` via the harness loader
 * (same as createWolfHarness, on the redirected den/env) -> open the engine store at `<den>/session.sqlite` (backup on) ->
 * root conversation (= the home thread) -> bring its agent state in line with config + project context ->
 * attach the server's watcher -> engine.resume() -> listen.
 *
 * Listener precedence here (library): socket option > port option > serve.port > ephemeral TCP. (The wolfd bin
 * resolves flags + config into these options; see bin/wolfd.ts.)
 * Agent state is only rewritten when it differs from what config + context say (configure appends a history entry).
 * Tier switching via configure is not wired yet (main tier only).
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Models } from "@earendil-works/pi-ai/models";
import type { Extension } from "@earendil-works/pi-durable";
import { applyWolfTierOverrides, assertSandboxed, loadModelTable, type ModelTable, loadWolfConfig, resolveWolfModel, type WolfConfig } from "@wolfpack/engine";
import {
  openWolfEngine,
  resolveToolNames,
  type ConfigureOptions,
  type EngineConversation,
  type ThinkingLevel,
  type WolfEngine,
} from "../engine/index.js";
import { loadExtensions, reportLoad, withoutProvided } from "../loader.js";
import { composeProjectContext } from "./context.js";
import { buildWolfModels } from "./models.js";
import { WolfServer } from "./server.js";
import { patchProcessEnv, startSandbox, type RunningSandbox, type StartWorkServer } from "./sandbox.js";
import { prepareSocketPath } from "./socket.js";

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
}

export interface ExtensionRuntime {
  config: WolfConfig;
  den: string;
  env: NodeJS.ProcessEnv;
  sandbox?: RunningSandbox;
}

export interface RunningWolf {
  url: string;
  config: WolfConfig;
  engine: WolfEngine;
  server: WolfServer;
  conversation: EngineConversation;
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
    sandbox = await startSandbox(config.sandbox.root, { startWorkServer: opts.startWorkServer, librarian: config.memory.librarian });
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
  if (config.sandbox) assertSandboxed(config.sandbox.root, { den: config.den, ...(sandbox ? { kbOps: sandbox.resolved.kbOps, kbDenLocal: sandbox.resolved.kbDenLocal, workEndpoint: sandbox.resolved.workEndpoint } : {}) });

  const { table: fileTable } = loadModelTable({ env, wolfYaml: config.file });
  // The wolf's table: models file + wolf.yaml `tiers:`. Handed to extensions so memory's engine steps use the same models.
  const table = applyWolfTierOverrides(fileTable, config);
  const model = resolveWolfModel(config, "main", table);
  const { extensions: toolExtensions, tools } = resolveToolNames(config.capability.tools);
  const extra = typeof opts.extraExtensions === "function" ? opts.extraExtensions({ config, den: config.den, env, ...(sandbox ? { sandbox } : {}) }) : (opts.extraExtensions ?? []);
  // The wolf's configured extensions, through the same loader createWolfHarness uses. This runs AFTER the sandbox
  // redirect (config.den and env are the sandbox's) and the assertSandboxed gate above, so the extensions' own
  // fail-closed gates (memoryGate) see the effective den/env.
  const loaded = await loadConfiguredExtensions(config, env, table, extra, log);
  const extensions = [...toolExtensions, ...loaded, ...extra];
  const cwd = config.capability.workspace;
  const context = composeProjectContext({ name: config.identity.name, domains: config.identity.domains, cwd, den: config.den, home: opts.home });

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
      tools: withExtensionTools(tools, engine.toolNames()),
      cwd,
      instructions: context.instructions,
    };
    const conversation = await engine.conversations.root(desired);
    await reconcile(conversation, desired);

    const server = new WolfServer({ name: config.identity.name, conversation, den: config.den, memoryExtension: memoryExtensionInstalled(extensions), onError: (e) => log(`server error: ${String(e)}`) });
    await server.attach();
    engine.resume();
    const url = opts.socket ? await server.listenSocket(opts.socket) : await server.listen(opts.port ?? config.serve.port ?? 0);
    return {
      url,
      config,
      engine,
      server,
      conversation,
      ...(sandbox ? { sandbox } : {}),
      close: async () => {
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
async function loadConfiguredExtensions(config: WolfConfig, env: NodeJS.ProcessEnv, modelTable: ModelTable, extra: readonly Extension[], log: (line: string) => void): Promise<Extension[]> {
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
  });
  reportLoad(result, { info: log, warn: (l) => log(`warning: ${l}`) });
  const broken = result.failed.filter((f) => !f.notFound);
  if (broken.length > 0) throw new Error(`extension ${broken.map((f) => `${f.name}: ${f.error}`).join("; ")}`);
  return result.extensions;
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
