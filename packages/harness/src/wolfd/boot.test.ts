/** startWolf end to end WITHOUT a model call: config -> engine store -> /v1. Real sqlite + pi-durable. */
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
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

const start = async (port?: number, socket?: string) => {
  const w = await startWolf({ configPath: join(root, "wolf.yaml"), env, home: root, port, socket });
  running.push(w);
  return w;
};

describe("startWolf", () => {
  it("serves /v1, applies project context + tools to the home conversation, persists across restarts", async () => {
    const w = await start();
    expect(w.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const wolves: any = await (await fetch(`${w.url}${buildPath("listWolves")}`)).json();
    expect(wolves.wolves).toEqual([{ id: "bootwolf", name: "bootwolf", host: "local", status: "online", librarian: false }]);

    const create = () => fetch(`${w.url}${buildPath("createThread", { name: "bootwolf" })}`, { method: "POST", body: '{"kind":"home"}' });
    const thread: any = await (await create()).json();
    expect(thread.id).toBe("bootwolf/home");

    const watch = await w.conversation.watch();
    const agent = watch.snapshot.agent;
    await watch.stop();
    expect(agent.model).toMatchObject({ provider: "anthropic", modelId: "claude-haiku-5-5" });
    expect(agent.tools).toEqual(["bash", "edit", "read", "show_decision", "write"]);
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

  it("boots a subscription-transport table onto the claude-bridge provider (no model call)", async () => {
    const tier = { model: "claude-haiku-5-5", modelSource: "default", provider: "claude-agent-sdk", piModel: "claude-bridge/claude-haiku-5-5" };
    writeFileSync(
      join(root, "models.json"),
      JSON.stringify({ location: "local", transport: "subscription", transportSource: "default", tiers: { main: tier, smart: tier, fast: tier }, steps: {}, warnings: [] }),
    );
    const w = await start();
    const detail: any = await (await fetch(`${w.url}${buildPath("getThread", { id: "bootwolf/home" })}`)).json();
    expect(detail.id).toBe("bootwolf/home");
    const watch = await w.conversation.watch();
    expect(watch.snapshot.agent.model).toMatchObject({ provider: "claude-bridge", modelId: "claude-haiku-5-5" });
    await watch.stop();
  });

  it("rejects unknown transports with a clear error", async () => {
    writeFileSync(
      join(root, "models.json"),
      JSON.stringify({ location: "local", transport: "carrier-pigeon", transportSource: "default", tiers: {}, steps: {}, warnings: [] }),
    );
    await expect(start()).rejects.toThrow(/transport/);
  });
});

const getOver = (socketPath: string, path: string): Promise<{ status: number; body: any }> =>
  new Promise((resolve, reject) => {
    const req = request({ socketPath, path }, (res) => {
      let buf = "";
      res.on("data", (d) => (buf += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(buf) }));
    });
    req.on("error", reject);
    req.end();
  });

describe("startWolf over a unix socket", () => {
  it("serves /v1/wolves on the socket (dir 0700), prints unix: url, removes the file on close", async () => {
    const sock = join(root, "run", "bootwolf.sock");
    const w = await start(undefined, sock);
    expect(w.url).toBe(`unix:${sock}`);
    expect(statSync(join(root, "run")).mode & 0o777).toBe(0o700);
    const r = await getOver(sock, "/v1/wolves");
    expect(r.status).toBe(200);
    expect(r.body.wolves[0]).toMatchObject({ name: "bootwolf", status: "online" });
    await w.close();
    running.length = 0;
    expect(existsSync(sock)).toBe(false);
  });

  it("removes a stale socket file before binding", async () => {
    const sock = join(root, "stale.sock");
    writeFileSync(sock, "");
    const w = await start(undefined, sock);
    expect((await getOver(sock, "/v1/wolves")).status).toBe(200);
    expect(w.url).toBe(`unix:${sock}`);
  });

  it("refuses to bind (and never opens the store) when a live wolfd answers on the socket", async () => {
    const sock = join(root, "live.sock");
    await start(undefined, sock);
    await expect(start(undefined, sock)).rejects.toThrow(/already serving/);
    // the first one is untouched
    expect((await getOver(sock, "/v1/wolves")).status).toBe(200);
  });
});
