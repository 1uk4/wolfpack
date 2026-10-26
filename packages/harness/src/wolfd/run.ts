/**
 * startWolf: boot ONE wolf process serving /v1 on 127.0.0.1.
 *
 * Sequence: load wolf.yaml -> resolve the main-tier model (WOLFPACK_MODELS_FILE / models.json beside the wolf /
 * pack config; subscription transport builds the claude-bridge provider) -> open the engine store at `<den>/session.sqlite` (backup on) ->
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
import { loadModelTable, loadWolfConfig, resolveWolfModel, type WolfConfig } from "@wolfpack/engine";
import {
  openWolfEngine,
  resolveToolNames,
  type ConfigureOptions,
  type EngineConversation,
  type ThinkingLevel,
  type WolfEngine,
} from "../engine/index.js";
import { composeProjectContext } from "./context.js";
import { buildWolfModels } from "./models.js";
import { WolfServer } from "./server.js";
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
  /** @internal test seam: extra engine extensions installed beside the configured tools (e.g. generation hooks). */
  extraExtensions?: readonly Extension[];
}

export interface RunningWolf {
  url: string;
  config: WolfConfig;
  engine: WolfEngine;
  server: WolfServer;
  conversation: EngineConversation;
  close(): Promise<void>;
}

export async function startWolf(opts: StartWolfOptions): Promise<RunningWolf> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => {});
  const { config, warnings } = loadWolfConfig(opts.configPath);
  for (const w of warnings) log(`warning: ${w}`);

  const { table } = loadModelTable({ env, wolfYaml: config.file });
  const model = resolveWolfModel(config, "main", table);
  const { extensions: toolExtensions, tools } = resolveToolNames(config.capability.tools);
  const extensions = [...toolExtensions, ...(opts.extraExtensions ?? [])];
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
      tools,
      cwd,
      instructions: context.instructions,
    };
    const conversation = await engine.conversations.root(desired);
    await reconcile(conversation, desired);

    const server = new WolfServer({ name: config.identity.name, conversation, onError: (e) => log(`server error: ${String(e)}`) });
    await server.attach();
    engine.resume();
    const url = opts.socket ? await server.listenSocket(opts.socket) : await server.listen(opts.port ?? config.serve.port ?? 0);
    return {
      url,
      config,
      engine,
      server,
      conversation,
      close: async () => {
        await server.close();
        await engine.close();
        wolfModels.shutdown();
      },
    };
  } catch (e) {
    await engine.close().catch(() => {});
    wolfModels.shutdown();
    throw e;
  }
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
