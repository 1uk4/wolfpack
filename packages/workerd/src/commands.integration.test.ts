/** Command channel end to end: one real hub, two in-process workerds (own temp dirs and ports), plus a raw old-style link. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createHubServer, createTokenStore, type HubServer } from "@wolfpack/hubd";
import { LINK_PROTOCOL_VERSION } from "@wolfpack/protocol";
import { runWorkerd, type RunningWorkerd } from "./run.js";
import type { KeyHandler } from "./commands.js";
import { FAKE_COMMAND, makeWolves, until } from "./testing/helpers.js";

let hub: HubServer;
let dataDir = "";
let store: ReturnType<typeof createTokenStore>;
let consoleToken = "";
const temps: string[] = [];
const running: RunningWorkerd[] = [];
const raws: WebSocket[] = [];

const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  temps.push(d);
  return d;
};
const mintWorker = (hostId: string) => store.redeem(store.mintPairingCode({ kind: "worker", hostId }).code, "it", "worker", hostId).token;

async function machine(hostId: string, wolf: string, keys?: KeyHandler) {
  const { root } = makeWolves(wolf);
  const base = tmp(`cmd-${hostId}-`);
  const w = await runWorkerd({
    wolvesDir: root,
    ...(keys ? { keys } : {}),
    port: 0,
    command: FAKE_COMMAND,
    hub: { hubUrl: hub.url, token: mintWorker(hostId), hostId },
    linkOptions: { baseMs: 20, capMs: 200, rand: () => 0.5 },
    configDir: join(base, "config"),
    kbMirrorDir: join(base, "mirror"),
    kbOps: join(base, "ops"),
    outboxDir: join(base, "outbox"),
    kbSync: { baseMs: 20, capMs: 200, pollMs: 0 },
    wake: { intervalMs: 3_600_000, netPollMs: 3_600_000 },
    feed: false,
    log: () => {},
  });
  running.push(w);
  await until(() => hub.link.presence(hostId) === "online", 8000, `${hostId} online`);
  await w.supervisor.whenSettled();
  return { w, root };
}
const run = async (hostId: string, body: unknown) => {
  const r = await fetch(`${hub.url}/v1/machines/${hostId}/commands`, { method: "POST", headers: { Authorization: `Bearer ${consoleToken}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};

beforeEach(async () => {
  dataDir = tmp("cmd-hub-");
  hub = await createHubServer({ dataDir, port: 0, authPollMs: 30, kbPollMs: 0, kbSettleMs: -1, linkTimers: { heartbeatMs: 100, deadAfterMs: 1000, helloTimeoutMs: 500, asleepOfflineMs: 60_000 } });
  store = createTokenStore(dataDir);
  consoleToken = store.redeem(store.mintPairingCode({ kind: "console" }).code, "it-console", "console").token;
});
afterEach(async () => {
  for (const r of raws.splice(0)) r.terminate();
  for (const w of running.splice(0)) await w.close();
  await hub.close();
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("command channel across a hub and two workerds", () => {
  it("delivers each command to the machine it names, and round-trips logs.fetch and wolves.restart", async () => {
    const a = await machine("mach-a", "alpha");
    const b = await machine("mach-b", "beta");
    const aPid = a.w.supervisor.status()[0]!.pid;
    const bPid = b.w.supervisor.status()[0]!.pid;

    const logs = await run("mach-a", { kind: "logs.fetch", args: { service: "alpha", lines: 50 } });
    expect(logs.status).toBe(200);
    expect(logs.body.ok).toBe(true);
    expect(logs.body.data.truncated).toBe(false);
    expect(logs.body.data.lines.join("\n")).toContain("supervisor: spawned pid"); // alpha's own wolfd log, from machine A only
    expect((await run("mach-b", { kind: "logs.fetch", args: { service: "alpha", lines: 5 } })).body).toMatchObject({ ok: false, code: "unknown_service" }); // B has no wolf "alpha"

    const restart = await run("mach-a", { kind: "wolves.restart", args: { wolf: "alpha" } });
    expect(restart.status).toBe(200);
    expect(restart.body).toMatchObject({ ok: true, data: { restarted: [{ wolf: "alpha", wasActive: true, midReply: false }] } });
    await a.w.supervisor.whenSettled();
    await until(() => a.w.supervisor.status()[0]!.pid !== aPid && a.w.supervisor.status()[0]!.state === "online", 8000, "alpha respawned");
    expect(b.w.supervisor.status()[0]!.pid).toBe(bPid); // the other machine was not touched
  });

  it("carries a max-size (64 KB) sealed key.set through the hub to the key handler intact", async () => {
    const seen: { sealed: string; hostId: string }[] = [];
    await machine("mach-k", "kappa", { set: async (a) => (seen.push({ sealed: a.sealed, hostId: a.hostId }), { ok: true }), remove: async () => ({ ok: true }) });
    const sealed = "A".repeat(64 * 1024);
    const r = await run("mach-k", { kind: "key.set", args: { slot: "anthropic" }, sealed });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true });
    expect(seen).toEqual([{ sealed, hostId: "mach-k" }]);
  });

  it("answers not_sent_offline once a machine's link is gone, and not_sent_unsupported for key commands nobody can store", async () => {
    const a = await machine("mach-a", "alpha");
    expect((await run("mach-a", { kind: "key.set", args: { slot: "anthropic" }, sealed: "x" })).body).toMatchObject({ ok: false, code: "not_sent_unsupported" });
    await a.w.close();
    running.splice(running.indexOf(a.w), 1);
    await until(() => hub.link.presence("mach-a") !== "online", 5000, "mach-a gone");
    const r = await run("mach-a", { kind: "wolves.restart", args: {} });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, code: "not_sent_offline" });
  });

  it("answers not_sent_unsupported for a worker whose hello has no commands (an old workerd)", async () => {
    const ws = new WebSocket(hub.url.replace("http", "ws") + "/v1/link", { headers: { Authorization: `Bearer ${mintWorker("old-box")}` } });
    raws.push(ws);
    let welcomed = false;
    let sawCmd = false;
    ws.on("message", (d) => {
      const f = JSON.parse(d.toString()) as { t: string };
      if (f.t === "welcome") welcomed = true;
      if (f.t === "cmd") sawCmd = true;
    });
    await new Promise<void>((res, rej) => (ws.once("open", () => res()), ws.once("error", rej)));
    ws.send(JSON.stringify({ t: "hello", v: LINK_PROTOCOL_VERSION, hostId: "old-box", laptop: false, wolves: [], kbRevisions: {} }));
    await until(() => welcomed, 4000, "welcome");
    const r = await run("old-box", { kind: "logs.fetch", args: { service: "workerd", lines: 5 } });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, code: "not_sent_unsupported" });
    expect(sawCmd).toBe(false);
  });
});
