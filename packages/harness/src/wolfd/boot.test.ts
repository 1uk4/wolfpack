/** startWolf end to end WITHOUT a model call: config -> engine store -> /v1. Real sqlite + pi-durable. */
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { HttpConsoleClient } from "@wolfpack/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPath } from "@wolfpack/protocol";
import { startWolf, type RunningWolf } from "./run.js";

let root: string;
let env: NodeJS.ProcessEnv;
const running: RunningWolf[] = [];

// The suite itself may run under an agent shell that carries the marker: start clean, give it back after.
let savedMarker: string | undefined;
beforeEach(() => {
  savedMarker = process.env.WOLFPACK_AGENT_RUN;
  delete process.env.WOLFPACK_AGENT_RUN;
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
  if (savedMarker === undefined) delete process.env.WOLFPACK_AGENT_RUN; else process.env.WOLFPACK_AGENT_RUN = savedMarker;
  await Promise.all(running.splice(0).map((w) => w.close()));
  rmSync(root, { recursive: true, force: true });
});

const start = async (port?: number, socket?: string) => {
  const w = await startWolf({ configPath: join(root, "wolf.yaml"), env, home: root, port, socket });
  running.push(w);
  return w;
};

describe("startWolf", () => {
  it("config den and name win over an inherited stale WOLF_DEN / WOLF_NAME, in the wolf env and process.env", async () => {
    const saved = { den: process.env.WOLF_DEN, name: process.env.WOLF_NAME };
    process.env.WOLF_DEN = "/stale/den";
    process.env.WOLF_NAME = "stale";
    try {
      // inherited env (opts.env unset): process.env is patched while running and restored on close
      const w = await startWolf({ configPath: join(root, "wolf.yaml"), home: root });
      expect(process.env.WOLF_DEN).toBe(w.config.den);
      expect(process.env.WOLF_NAME).toBe("bootwolf");
      await w.close();
      expect(process.env.WOLF_DEN).toBe("/stale/den");
      expect(process.env.WOLF_NAME).toBe("stale");
      // explicit env: wolf env carries the config den, process.env untouched
      env = { ...env, WOLF_DEN: "/stale/den", WOLF_NAME: "stale" };
      let seen: NodeJS.ProcessEnv | undefined;
      const w2 = await startWolf({ configPath: join(root, "wolf.yaml"), env, home: root, extraExtensions: (c) => { seen = c.env; return []; } });
      running.push(w2);
      expect(seen?.WOLF_DEN).toBe(w2.config.den);
      expect(seen?.WOLF_NAME).toBe("bootwolf");
      expect(process.env.WOLF_DEN).toBe("/stale/den");
    } finally {
      if (saved.den === undefined) delete process.env.WOLF_DEN; else process.env.WOLF_DEN = saved.den;
      if (saved.name === undefined) delete process.env.WOLF_NAME; else process.env.WOLF_NAME = saved.name;
    }
  });

  it("never puts the agent marker into wolfd's own process.env, with two wolves running", async () => {
    mkdirSync(join(root, "work2"));
    writeFileSync(join(root, "wolf2.yaml"), `name: bootwolf2\nworkspace: ${join(root, "work2")}\n`);
    // (inherited env: the path that patches process.env for the wolf's lifetime)
    const w1 = await startWolf({ configPath: join(root, "wolf.yaml"), home: root });
    running.push(w1);
    expect(process.env.WOLFPACK_AGENT_RUN).toBeUndefined();
    const w2 = await startWolf({ configPath: join(root, "wolf2.yaml"), home: root });
    running.push(w2);
    expect(process.env.WOLFPACK_AGENT_RUN).toBeUndefined();
    await w1.close();
    await w2.close();
    expect(process.env.WOLFPACK_AGENT_RUN).toBeUndefined();
  });

  it("exports the wolf's subscriptions as WOLF_DOMAINS, overriding an inherited value, restored on close", async () => {
    writeFileSync(join(root, "wolf.yaml"), `name: bootwolf\nworkspace: ${join(root, "work")}\ndomains: [personal, snapjack]\n`);
    const saved = process.env.WOLF_DOMAINS;
    process.env.WOLF_DOMAINS = "stale";
    try {
      const w = await startWolf({ configPath: join(root, "wolf.yaml"), home: root });
      expect(process.env.WOLF_DOMAINS).toBe("personal,snapjack");
      await w.close();
      expect(process.env.WOLF_DOMAINS).toBe("stale");
      let seen: NodeJS.ProcessEnv | undefined;
      const w2 = await startWolf({ configPath: join(root, "wolf.yaml"), env: { ...env, WOLF_DOMAINS: "stale" }, home: root, extraExtensions: (c) => { seen = c.env; return []; } });
      running.push(w2);
      expect(seen?.WOLF_DOMAINS).toBe("personal,snapjack");
    } finally {
      if (saved === undefined) delete process.env.WOLF_DOMAINS; else process.env.WOLF_DOMAINS = saved;
    }
  });

  it("serves /v1, applies project context + tools to the home conversation, persists across restarts", async () => {
    const w = await start();
    expect(w.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const wolves: any = await (await fetch(`${w.url}${buildPath("listWolves")}`)).json();
    expect(wolves.wolves).toEqual([{ id: "bootwolf", name: "bootwolf", host: "local", status: "online", librarian: false, kbReadable: false }]);

    const create = () => fetch(`${w.url}${buildPath("createThread", { name: "bootwolf" })}`, { method: "POST", body: '{"kind":"home"}' });
    const thread: any = await (await create()).json();
    expect(thread.id).toBe("bootwolf/home");

    const watch = await w.conversation.watch();
    const agent = watch.snapshot.agent;
    await watch.stop();
    expect(agent.model).toMatchObject({ provider: "anthropic", modelId: "claude-haiku-5-5" });
    expect(agent.tools).toEqual([
      "ask",
      "ask_revise",
      "bash",
      "edit",
      "read",
      "show_checklist",
      "show_decision",
      "show_graph",
      "subagent",
      "subagent_merge",
      "subagent_message",
      "subagent_stop",
      "subagents_list",
      "write",
    ]);
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

  it("boots a subscription-transport table (legacy claude-bridge piModel) onto claude-stateless (no model call)", async () => {
    const tier = { model: "claude-haiku-5-5", modelSource: "default", provider: "claude-agent-sdk", piModel: "claude-bridge/claude-haiku-5-5" };
    writeFileSync(
      join(root, "models.json"),
      JSON.stringify({ location: "local", transport: "subscription", transportSource: "default", tiers: { main: tier, smart: tier, fast: tier }, steps: {}, warnings: [] }),
    );
    const w = await start();
    const detail: any = await (await fetch(`${w.url}${buildPath("getThread", { id: "bootwolf/home" })}`)).json();
    expect(detail.id).toBe("bootwolf/home");
    const watch = await w.conversation.watch();
    expect(watch.snapshot.agent.model).toMatchObject({ provider: "claude-stateless", modelId: "claude-haiku-5-5" });
    await watch.stop();
  });

  it("a stored claude-bridge root is reconciled to claude-stateless at boot and takes its turn there", async () => {
    const tier = { model: "claude-haiku-5-5", modelSource: "default", provider: "claude-agent-sdk", piModel: "claude-stateless/claude-haiku-5-5" };
    writeFileSync(
      join(root, "models.json"),
      JSON.stringify({ location: "local", transport: "subscription", transportSource: "default", tiers: { main: tier, smart: tier, fast: tier }, steps: {}, warnings: [] }),
    );
    const registry = (stateless: string[]) => {
      const mk = (provider: string, texts: string[]) => {
        const faux = fauxProvider({ provider, api: provider, models: [{ id: "claude-haiku-5-5" }], tokensPerSecond: undefined });
        faux.setResponses(texts.map((t) => fauxAssistantMessage(t)));
        return faux;
      };
      const st = mk("claude-stateless", stateless);
      const legacy = mk("claude-bridge", []); // lookup-only stand-in: any use would exhaust its (empty) script
      const models = createModels();
      models.setProvider(st.provider);
      models.setProvider(legacy.provider);
      return { models, st, legacy };
    };
    // Boot once: creates the root on claude-stateless. Then rewrite the stored root as the retired provider left it.
    const first = await startWolf({ configPath: join(root, "wolf.yaml"), env, home: root, models: registry([]).models });
    const den = first.config.den;
    await first.close();
    const db = new DatabaseSync(join(den, "session.sqlite"));
    db.exec("update document_revisions set content = replace(content, 'claude-stateless', 'claude-bridge')");
    const stored = (db.prepare("select content as v from document_revisions").all() as Array<{ v: string }>).map((r) => r.v).join("");
    db.close();
    expect(stored).toContain('"claude-bridge"');
    expect(stored).not.toContain('"claude-stateless"');

    const reg = registry(["pong"]);
    const w = await startWolf({ configPath: join(root, "wolf.yaml"), env, home: root, models: reg.models });
    running.push(w);
    const watch = await w.conversation.watch();
    expect(watch.snapshot.agent.model).toMatchObject({ provider: "claude-stateless", modelId: "claude-haiku-5-5" });
    await watch.stop();

    const client = new HttpConsoleClient({ baseUrl: w.url });
    await client.submit("bootwolf/home", "ping", { whenBusy: "reject" });
    const events: any[] = [];
    for await (const e of client.watch("bootwolf/home")) events.push(e);
    expect(events.at(-1)).toMatchObject({ type: "turn-end", reason: "complete" });
    const detail = await client.getThread("bootwolf/home");
    expect(detail.messages.map((m) => [m.role, m.text])).toEqual([["user", "ping"], ["assistant", "pong"]]);
    expect(reg.st.state.callCount).toBe(1);
    expect(reg.legacy.state.callCount).toBe(0);
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
