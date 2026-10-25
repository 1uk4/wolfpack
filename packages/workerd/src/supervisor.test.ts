import { existsSync, readFileSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { Supervisor, backoffDelay } from "./supervisor.js";
import { FAKE_COMMAND, makeWolves, until } from "./testing/helpers.js";

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

describe("Supervisor (real wolfd bin)", () => {
  const bin = new URL("../../harness/dist/bin/wolfd.js", import.meta.url).pathname;
  it.skipIf(!existsSync(bin))("boots, serves /v1/wolves, shuts down (no turns, no API key)", async () => {
    const m = makeWolves("realwolf");
    root = m.root;
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    mkdirSync(join(root, "realwolf", "work"));
    writeFileSync(join(root, "realwolf", "wolf.yaml"), `name: realwolf\nworkspace: ${join(root, "realwolf", "work")}\n`);
    const tier = { model: "claude-haiku-5-5", modelSource: "default", provider: "anthropic", piModel: "anthropic/claude-haiku-5-5" };
    writeFileSync(
      join(root, "models.json"),
      JSON.stringify({ location: "local", transport: "api", transportSource: "default", tiers: { main: tier, smart: tier, fast: tier }, steps: {}, warnings: [] }),
    );
    const { discoverWolves } = await import("@wolfpack/engine");
    sup = new Supervisor({
      wolves: discoverWolves(root).wolves.map((l) => l.config),
      command: [process.execPath, bin],
      env: { ...process.env, WOLFPACK_MODELS_FILE: join(root, "models.json"), HOME: root },
      log: () => {},
    });
    sup.start();
    await sup.whenSettled(20_000);
    expect(sup.status()[0].state).toBe("online");
    const body = await (await fetch(`${sup.upstream("realwolf")}/v1/wolves`)).json();
    expect(body.wolves[0].name).toBe("realwolf");
    await sup.stop();
    expect(sup.status()[0].state).toBe("stopped");
  }, 40_000);
});
