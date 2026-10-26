/**
 * Test helper: boot a real wolf (real sqlite + pi-durable, /v1 over HTTP) on a temp den with a scripted model
 * provider and optional extra generation hooks. Importable by any test; not part of the shipped surface.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineExtension, defineTask, GenerationTask, hook, type Extension } from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { HttpConsoleClient, type ThreadEvent } from "@wolfpack/client";
import { createScriptedModel, type FauxResponseStep, type ScriptedModel } from "./scripted-model.js";
import { startWolf, type ExtensionRuntime, type RunningWolf } from "./run.js";

export interface AfterResponseCall {
  message: AssistantMessage;
  /** pi-durable conversation id as the hook sees it (api.conversationId). */
  conversationId: string;
  taskId: string;
}

export interface TestWolfOptions {
  script: FauxResponseStep[];
  hooks?: {
    afterResponse?: (call: AfterResponseCall) => void | Promise<void>;
    /** Extra raw pi-durable extensions (tools, hooks) installed beside the coding tools. */
    extensions?: Extension[] | ((rt: ExtensionRuntime) => Extension[]);
  };
  name?: string;
  /** Extra top-level wolf.yaml text appended after `name` / `workspace` (e.g. a `sandbox:` block). */
  yaml?: string;
}

export interface TestWolf {
  url: string;
  /** Thread id of the home conversation, e.g. "testwolf/home". */
  home: string;
  wolf: RunningWolf;
  client: HttpConsoleClient;
  scripted: ScriptedModel;
  /** Every afterResponse seen (recorded even when no hook is given). */
  afterResponse: AfterResponseCall[];
  /** Submit on the home thread and resolve with its events once the turn ends. */
  submit(text: string): Promise<ThreadEvent[]>;
  stop(): Promise<void>;
}

export async function startTestWolf(opts: TestWolfOptions): Promise<TestWolf> {
  const name = opts.name ?? "testwolf";
  const root = mkdtempSync(join(tmpdir(), "test-wolf-"));
  const scripted = createScriptedModel(opts.script);
  const tier = { model: scripted.modelId, modelSource: "default", provider: scripted.provider, piModel: `${scripted.provider}/${scripted.modelId}` };
  writeFileSync(
    join(root, "models.json"),
    JSON.stringify({ location: "local", transport: "api", transportSource: "default", tiers: { main: tier, smart: tier, fast: tier }, steps: {}, warnings: [] }),
  );
  mkdirSync(join(root, "work"));
  writeFileSync(join(root, "wolf.yaml"), `name: ${name}\nworkspace: ${join(root, "work")}\n${opts.yaml ?? ""}`);

  const afterResponse: AfterResponseCall[] = [];
  const recorder = defineExtension({
    name: "test-wolf-recorder",
    hooks: [
      hook(GenerationTask, {
        afterResponse: async (message, api) => {
          const call = { message, conversationId: String(api.conversationId), taskId: String(api.taskId) };
          afterResponse.push(call);
          await opts.hooks?.afterResponse?.(call);
        },
      }),
    ],
  });

  let wolf: RunningWolf;
  try {
    wolf = await startWolf({
      configPath: join(root, "wolf.yaml"),
      env: { WOLFPACK_MODELS_FILE: join(root, "models.json") },
      home: root,
      models: scripted.models,
      extraExtensions: (rt) => {
        const extra = opts.hooks?.extensions;
        return [recorder, ...(typeof extra === "function" ? extra(rt) : (extra ?? []))];
      },
    });
  } catch (e) {
    rmSync(root, { recursive: true, force: true });
    throw e;
  }
  const client = new HttpConsoleClient({ baseUrl: wolf.url });
  const home = `${name}/home`;
  return {
    url: wolf.url,
    home,
    wolf,
    client,
    scripted,
    afterResponse,
    async submit(text) {
      await client.submit(home, text, { whenBusy: "reject" });
      const events: ThreadEvent[] = [];
      for await (const e of client.watch(home)) events.push(e);
      return events;
    },
    async stop() {
      await wolf.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A task that sleeps forever: a live owner for a task-owned (subagent-style) conversation. */
export const Park = defineTask<Record<string, never>, { phase: "park" }, null>({
  name: "test.park",
  version: 1,
  initial: () => ({ phase: "park" }),
  phases: {
    park: async (_task, runtime, c) => runtime.sleepUntil(runtime.now() + 1e12, { phase: "park" }, c),
  },
  abort: async (_task, runtime, c) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), c),
});
export const parkExtension = defineExtension({ name: "test-park", tasks: [Park] });

