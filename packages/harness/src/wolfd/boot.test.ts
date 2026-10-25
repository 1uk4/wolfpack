/** startWolf end to end WITHOUT a model call: config -> engine store -> /v1. Real sqlite + pi-durable. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPath } from "@wolfpack/protocol";
import { startWolf, type RunningWolf } from "./run.js";

let root: string;
let env: NodeJS.ProcessEnv;
const running: RunningWolf[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wolfd-boot-"));
  const tier = { model: "claude-haiku-5-5", modelSource: "default", provider: "anthropic", piModel: "anthropic/claude-haiku-5-5" };
  writeFileSync(
    join(root, "models.json"),
    JSON.stringify({
      location: "local",
      transport: "api",
      transportSource: "default",
      tiers: { main: tier, smart: tier, fast: tier },
      steps: {},
      warnings: [],
    }),
  );
  mkdirSync(join(root, "work"));
  writeFileSync(join(root, "work", "AGENTS.md"), "BOOT-TEST-AGENTS");
  writeFileSync(join(root, "wolf.yaml"), `name: bootwolf\nworkspace: ${join(root, "work")}\n`);
  env = { WOLFPACK_MODELS_FILE: join(root, "models.json") };
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((w) => w.close()));
  rmSync(root, { recursive: true, force: true });
});

const start = async (port?: number) => {
  const w = await startWolf({ configPath: join(root, "wolf.yaml"), env, home: root, port });
  running.push(w);
  return w;
};

describe("startWolf", () => {
  it("serves /v1, applies project context + tools to the home conversation, persists across restarts", async () => {
    const w = await start();
    expect(w.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const wolves: any = await (await fetch(`${w.url}${buildPath("listWolves")}`)).json();
    expect(wolves.wolves).toEqual([{ id: "bootwolf", name: "bootwolf", host: "local", status: "online" }]);

    const create = () => fetch(`${w.url}${buildPath("createThread", { name: "bootwolf" })}`, { method: "POST", body: '{"kind":"home"}' });
    const thread: any = await (await create()).json();
    expect(thread.id).toBe("bootwolf/home");

    const watch = await w.conversation.watch();
    const agent = watch.snapshot.agent;
    await watch.stop();
    expect(agent.model).toMatchObject({ provider: "anthropic", modelId: "claude-haiku-5-5" });
    expect(agent.tools).toEqual(["read", "write", "edit", "bash"]);
    expect(agent.cwd).toBe(join(root, "work"));
    expect(agent.instructions).toContain("BOOT-TEST-AGENTS");

    const detail: any = await (await fetch(`${w.url}${buildPath("getThread", { id: "bootwolf/home" })}`)).json();
    expect(detail).toMatchObject({ busy: false, messages: [] });
    await w.close();
    running.length = 0;

    // Restart on the same store: same conversation, config unchanged -> still serving.
    const again = await start();
    const detail2: any = await (await fetch(`${again.url}${buildPath("getThread", { id: "bootwolf/home" })}`)).json();
    expect(detail2.id).toBe("bootwolf/home");
  });

  it("rejects subscription-transport models files with a clear error", async () => {
    writeFileSync(
      join(root, "models.json"),
      JSON.stringify({ location: "local", transport: "subscription", transportSource: "default", tiers: {}, steps: {}, warnings: [] }),
    );
    await expect(start()).rejects.toThrow(/subscription/);
  });
});
