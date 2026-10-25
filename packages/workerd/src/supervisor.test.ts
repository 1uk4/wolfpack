import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerdServer } from "./proxy.js";
import { Supervisor, backoffDelay, defaultWolfdCommand } from "./supervisor.js";
import { FAKE_COMMAND, FAKE_WOLF, makeWolves, until } from "./testing/helpers.js";

let sup: Supervisor | undefined;
let root = "";
afterEach(async () => {
  await sup?.stop();
  sup = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
});

const crash = (url: string) => fetch(`${url}/crash`).catch(() => undefined);

describe("backoffDelay", () => {
  it("doubles from base and caps", () => {
    const b = { baseMs: 500, capMs: 30_000, healthyResetMs: 60_000 };
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => backoffDelay(n, b))).toEqual([500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });
});

describe("Supervisor (fake wolf)", () => {
  it("boots each wolf, exposes urls, logs to <den>/logs/wolfd.log, stops cleanly", async () => {
    const m = makeWolves("alpha", "beta");
    root = m.root;
    const lines: string[] = [];
    sup = new Supervisor({ wolves: m.wolves, command: FAKE_COMMAND, log: (l) => lines.push(l) });
    sup.start();
    await sup.whenSettled();
    expect(sup.status().map((s) => [s.name, s.state])).toEqual([["alpha", "online"], ["beta", "online"]]);
    const url = sup.upstream("alpha")!;
    expect((await (await fetch(`${url}/v1/wolves`)).json()).wolves[0].name).toBe("alpha");
    expect(lines.some((l) => l.startsWith("[alpha] ") && l.includes("serving http://"))).toBe(true);
    const logFile = sup.status()[0].logFile;
    expect(logFile.endsWith("/den/logs/wolfd.log")).toBe(true);
    expect(readFileSync(logFile, "utf8")).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z .*serving http/m);
    await sup.stop();
    expect(sup.status().every((s) => s.state === "stopped")).toBe(true);
    expect(sup.upstream("alpha")).toBeUndefined();
  });

  it("restarts a crashed child with backoff and counts restarts", async () => {
    const m = makeWolves("alpha");
    root = m.root;
    sup = new Supervisor({ wolves: m.wolves, command: FAKE_COMMAND, backoff: { baseMs: 100, capMs: 400, healthyResetMs: 60_000 }, log: () => {} });
    sup.start();
    await sup.whenSettled();
    const firstUrl = sup.upstream("alpha")!;
    await crash(firstUrl);
    await until(() => sup!.status()[0].state === "restarting", 5000, "restarting");
    expect(sup.upstream("alpha")).toBeUndefined();
    await until(() => sup!.status()[0].state === "online", 5000, "back online");
    expect(sup.status()[0].restarts).toBe(1);
    expect(sup.upstream("alpha")).not.toBe(firstUrl);
    // second consecutive crash waits longer (failures=2 → 200ms)
    await crash(sup.upstream("alpha")!);
    await until(() => sup!.status()[0].state === "restarting", 5000, "restarting 2");
    expect(sup.status()[0].failures).toBe(2);
    expect(sup.status()[0].nextRestartInMs).toBeGreaterThan(100);
    await until(() => sup!.status()[0].state === "online", 5000, "online 2");
    expect(sup.status()[0].restarts).toBe(2);
  });

  it("marks a wolf failed after maxRestarts consecutive crashes", async () => {
    const m = makeWolves("alpha");
    root = m.root;
    sup = new Supervisor({
      wolves: m.wolves,
      command: FAKE_COMMAND,
      env: { ...process.env, FAKE_EXIT_IMMEDIATELY: "1" },
      backoff: { baseMs: 10, capMs: 20, healthyResetMs: 60_000 },
      maxRestarts: 3,
      log: () => {},
    });
    sup.start();
    await until(() => sup!.status()[0].state === "failed", 5000, "failed");
    expect(sup.status()[0].restarts).toBe(3);
    expect(readFileSync(sup.status()[0].logFile, "utf8")).toContain("marked failed");
  });

  it("SIGKILLs a child that ignores SIGTERM after the grace period", async () => {
    const m = makeWolves("alpha");
    root = m.root;
    sup = new Supervisor({
      wolves: m.wolves,
      command: [process.execPath, "-e", "process.on('SIGTERM',()=>{});console.log('wolfd: alpha serving http://127.0.0.1:1');setInterval(()=>{},1000)", "--"],
      graceMs: 200,
      log: () => {},
    });
    sup.start();
    await sup.whenSettled();
    const t = Date.now();
    await sup.stop();
    expect(Date.now() - t).toBeGreaterThanOrEqual(150);
    expect(sup.status()[0].state).toBe("stopped");
  });
});

describe("Supervisor (socket transport, fake wolf)", () => {
  let orphan: ChildProcess | undefined;
  let proxy: WorkerdServer | undefined;
  afterEach(async () => {
    orphan?.kill("SIGKILL");
    orphan = undefined;
    await proxy?.close();
    proxy = undefined;
  });
  const sockOf = (m: { wolves: { serve: { socket: string } }[] }) => m.wolves[0].serve.socket;

  it("spawns with --socket <serve.socket>, reports unix: url, proxies over the socket", async () => {
    const m = makeWolves("alpha");
    root = m.root;
    sup = new Supervisor({ wolves: m.wolves, command: FAKE_COMMAND, transport: "socket", log: () => {} });
    sup.start();
    await sup.whenSettled();
    expect(sup.upstream("alpha")).toBe(`unix:${sockOf(m)}`);
    expect(sup.status()[0].adopted).toBe(false);
    proxy = new WorkerdServer({ registry: sup });
    const base = await proxy.listen();
    const d = await (await fetch(`${base}/v1/threads/${encodeURIComponent("alpha/home")}`)).json();
    expect(d.served_by).toBe("alpha");
    const list = await (await fetch(`${base}/v1/wolves`)).json();
    expect(list.wolves[0]).toMatchObject({ name: "alpha", status: "online", host: "fake" });
    const sse = await fetch(`${base}/v1/threads/${encodeURIComponent("alpha/home")}/stream`);
    expect(await sse.text()).toContain("[DONE]");
  });

  it("adopts a live orphan on the socket: no second spawn, proxy works, healthz shows adopted", async () => {
    const m = makeWolves("alpha");
    root = m.root;
    const sock = sockOf(m);
    orphan = spawn(process.execPath, [FAKE_WOLF, "--config", m.wolves[0].file, "--socket", sock], { stdio: "ignore" });
    await until(() => existsSync(sock), 5000, "orphan socket");
    const marker = join(root, "spawned");
    const lines: string[] = [];
    sup = new Supervisor({
      wolves: m.wolves,
      // would drop a marker file if the supervisor spawned anything
      command: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'x')`, "--"],
      transport: "socket",
      log: (l) => lines.push(l),
    });
    sup.start();
    await sup.whenSettled();
    expect(sup.status()[0]).toMatchObject({ state: "online", adopted: true, pid: null });
    expect(lines.some((l) => l.includes("adopted orphan"))).toBe(true);
    proxy = new WorkerdServer({ registry: sup, health: () => ({ ok: true, wolves: sup!.status() }) });
    const base = await proxy.listen();
    expect((await (await fetch(`${base}/v1/threads/${encodeURIComponent("alpha/home")}`)).json()).served_by).toBe("alpha");
    expect((await (await fetch(`${base}/healthz`)).json()).wolves[0]).toMatchObject({ state: "online", adopted: true });
    await sup.stop();
    expect(existsSync(marker)).toBe(false);
    // adopted wolves are not ours to kill
    expect(orphan.exitCode).toBeNull();
    expect(existsSync(sock)).toBe(true);
  });

  it("restarts via spawn when an adopted orphan dies", async () => {
    const m = makeWolves("alpha");
    root = m.root;
    const sock = sockOf(m);
    orphan = spawn(process.execPath, [FAKE_WOLF, "--config", m.wolves[0].file, "--socket", sock], { stdio: "ignore" });
    await until(() => existsSync(sock), 5000, "orphan socket");
    sup = new Supervisor({ wolves: m.wolves, command: FAKE_COMMAND, transport: "socket", backoff: { baseMs: 50, capMs: 100, healthyResetMs: 60_000 }, log: () => {} });
    sup.start();
    await sup.whenSettled();
    expect(sup.status()[0].adopted).toBe(true);
    orphan.kill("SIGKILL"); // leaves a stale socket file behind
    await until(() => sup!.status()[0].adopted === false && sup!.status()[0].state === "online", 8000, "respawned");
    expect(sup.status()[0].pid).not.toBeNull();
  });

  it("removes a stale socket file (nothing answering) and spawns", async () => {
    const m = makeWolves("alpha");
    root = m.root;
    writeFileSync(sockOf(m), "");
    const lines: string[] = [];
    sup = new Supervisor({ wolves: m.wolves, command: FAKE_COMMAND, transport: "socket", log: (l) => lines.push(l) });
    sup.start();
    await sup.whenSettled();
    expect(sup.status()[0]).toMatchObject({ state: "online", adopted: false });
    expect(lines.some((l) => l.includes("removed stale socket"))).toBe(true);
  });
});

describe("Supervisor (real wolfd bin)", () => {
  const bin = new URL("../../harness/dist/bin/wolfd.js", import.meta.url).pathname;
  it.skipIf(!existsSync(bin))("default command resolves the harness bin without PATH", () => {
    const [node, entry] = defaultWolfdCommand();
    expect(node).toBe(process.execPath);
    expect(existsSync(entry)).toBe(true);
    expect(entry.endsWith("/dist/bin/wolfd.js")).toBe(true);
  });

  it.skipIf(!existsSync(bin))("default spawn (stripped PATH, socket) boots, serves through the proxy, shuts down (no turns, no API key)", async () => {
    const m = makeWolves("realwolf");
    root = m.root;
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(root, "realwolf", "work"));
    writeFileSync(
      join(root, "realwolf", "wolf.yaml"),
      `name: realwolf\nworkspace: ${join(root, "realwolf", "work")}\nserve:\n  socket: ${join(root, "realwolf.sock")}\n`,
    );
    const tier = { model: "claude-haiku-5-5", modelSource: "default", provider: "anthropic", piModel: "anthropic/claude-haiku-5-5" };
    writeFileSync(
      join(root, "models.json"),
      JSON.stringify({ location: "local", transport: "api", transportSource: "default", tiers: { main: tier, smart: tier, fast: tier }, steps: {}, warnings: [] }),
    );
    const { discoverWolves } = await import("@wolfpack/engine");
    sup = new Supervisor({
      wolves: discoverWolves(root).wolves.map((l) => l.config),
      env: { WOLFPACK_MODELS_FILE: join(root, "models.json"), HOME: root, PATH: "/nonexistent" },
      log: () => {},
    });
    sup.start();
    await sup.whenSettled(20_000);
    expect(sup.status()[0].state).toBe("online");
    expect(sup.upstream("realwolf")).toBe(`unix:${join(root, "realwolf.sock")}`);
    const server = new WorkerdServer({ registry: sup });
    const base = await server.listen();
    try {
      const body = await (await fetch(`${base}/v1/wolves`)).json();
      expect(body.wolves[0]).toMatchObject({ name: "realwolf", status: "online" });
      const created = await fetch(`${base}/v1/wolves/realwolf/threads`, { method: "POST", body: '{"kind":"home"}' });
      expect((await created.json()).id).toBe("realwolf/home");
    } finally {
      await server.close();
    }
    await sup.stop();
    expect(sup.status()[0].state).toBe("stopped");
    expect(existsSync(join(root, "realwolf.sock"))).toBe(false);
  }, 40_000);
});
