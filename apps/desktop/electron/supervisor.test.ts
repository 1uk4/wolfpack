/**
 * Seam: the app supervisor (electron/supervisor.cjs), driven from Node with temp dirs and a fake Anthropic server on
 * 127.0.0.1. Real hubd, workerd and wolfd children run from the bundles in apps/desktop/runtime.
 * Needs `node apps/desktop/scripts/build-runtime.mjs` first. The children run under Electron's own Node (the electron
 * binary in node_modules) unless WOLFPACK_DESKTOP_TEST_NODE=1 selects this process's Node (CI has no Electron binary).
 * The three tests share one run: start, chat, stop, start again (test 1); inspect it while up (test 2); stop it (test 3).
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpConsoleClient } from "@wolfpack/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const { createSupervisor } = createRequire(import.meta.url)("./supervisor.cjs");
const runtimeDir = join(here, "..", "runtime");

function nodeBin(): string {
  if (process.env.WOLFPACK_DESKTOP_TEST_NODE === "1") return process.execPath;
  const electronDir = join(here, "..", "node_modules", "electron");
  const pathTxt = join(electronDir, "path.txt");
  if (!existsSync(pathTxt)) throw new Error("Electron binary is not installed (run `node install.js` in node_modules/electron), or set WOLFPACK_DESKTOP_TEST_NODE=1 to use this Node");
  return join(electronDir, "dist", readFileSync(pathTxt, "utf8"));
}

let fake: Server;
let fakeUrl: string;
let root: string;
let nodePath: string;
const seenKeys: string[] = [];

/** A minimal Anthropic Messages endpoint: every call answers "FAKE-REPLY-OK", streamed or not. */
beforeAll(async () => {
  if (!existsSync(join(runtimeDir, "hubd.mjs"))) throw new Error("apps/desktop/runtime is not built: run `node apps/desktop/scripts/build-runtime.mjs` after `pnpm -r --filter \"./packages/*\" build`");
  nodePath = nodeBin();
  fake = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seenKeys.push(String(req.headers["x-api-key"] ?? ""));
      const stream = JSON.parse(body || "{}").stream === true;
      const usage = { input_tokens: 5, output_tokens: 3 };
      const msg = { id: "msg_fake", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: "FAKE-REPLY-OK" }], stop_reason: "end_turn", stop_sequence: null, usage };
      if (!stream) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(msg));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev("message_start", { message: { ...msg, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 1 } } });
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "FAKE-REPLY-OK" } });
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } });
      ev("message_stop", {});
      res.end();
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  fakeUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
  root = mkdtempSync(join(tmpdir(), "app-sup-"));
});
const made: Array<ReturnType<typeof createSupervisor>> = [];
afterAll(async () => {
  await Promise.all(made.map((m) => m.stop()));
  await new Promise((r) => fake?.close(r));
  if (root) rmSync(root, { recursive: true, force: true });
});

const make = () => {
  const s = createSupervisor({ stateDir: join(root, "state"), wolvesDir: join(root, "Wolves"), runtimeDir, nodeBin: nodePath, apiKey: "sk-test-fake-key", modelBaseUrl: fakeUrl });
  made.push(s);
  return s;
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The pid listening on a port (lsof), i.e. which process is hubd right now. */
function hubPid(port: number): number {
  return Number(execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).split("\n")[0]);
}

/** A process's command line and environment as ps shows them (same user). Fake keys only; never log it. */
function procEnv(pid: number): string {
  return execFileSync("ps", ["eww", "-p", String(pid)], { encoding: "utf8" });
}

async function say(url: string, text: string): Promise<string> {
  const c = new HttpConsoleClient({ baseUrl: url });
  await c.submit("wolf/home", text, { whenBusy: "reject" });
  let reply = "";
  for await (const e of c.watch("wolf/home")) if (e.type === "text-delta") reply += e.text;
  return reply;
}

/** Socket names (local, or local->remote) of the pids' TCP sockets in one state. lsof exits 1 when there are none. */
function sockets(pids: number[], state: "LISTEN" | "ESTABLISHED"): string[] {
  let out = "";
  try {
    out = execFileSync("lsof", ["-nP", "-a", "-p", pids.join(","), "-iTCP", `-sTCP:${state}`, "-Fn"], { encoding: "utf8" });
  } catch (e) {
    if ((e as { status?: number }).status !== 1) throw e;
  }
  return out.split("\n").filter((l) => l.startsWith("n")).map((l) => l.slice(1));
}

const loopback = /^(127\.0\.0\.1|\[::1\]):\d+$/;

describe("app runtime on one Mac", () => {
  let second: ReturnType<typeof make> | undefined;
  let secondPids: number[] = [];
  const established = new Set<string>();

  it("stop() during start leaves no child and starts none after it", async () => {
    const s = make();
    const started = s.start();
    const rejected = expect(started).rejects.toThrow(/stopped/);
    await new Promise((r) => setTimeout(r, 700)); // hubd is spawned, workerd not up yet
    await s.stop();
    const pidsAtStop = s.allPids();
    await rejected;
    await new Promise((r) => setTimeout(r, 1500)); // a retry would have spawned by now
    expect(s.allPids()).toEqual([]);
    expect(pidsAtStop).toEqual([]);
  }, 60_000);

  it("comes up on another port when the picked port is taken before the child binds it", async () => {
    const squatter = createNetServer((sock) => sock.destroy()); // holds the port; drops any health probe so close() can finish
    await new Promise<void>((r) => squatter.listen(0, "127.0.0.1", r));
    const taken = (squatter.address() as { port: number }).port;
    let calls = 0;
    // The 2nd pick (workerd's) hands out the occupied port: the port is taken between pick and bind.
    const pickPort = async (free: () => Promise<number>) => (++calls === 2 ? taken : free());
    const s = createSupervisor({ stateDir: join(root, "state-busy"), wolvesDir: join(root, "WolvesBusy"), runtimeDir, nodeBin: nodePath, apiKey: "sk-test-fake-key", modelBaseUrl: fakeUrl, pickPort });
    made.push(s);
    try {
      await s.start();
      expect(s.status().running).toBe(true);
      expect(s.ports.workerd).not.toBe(taken);
      expect(s.ports.hubd).not.toBe(taken);
      expect(s.urls.workerd).toBe(`http://127.0.0.1:${s.ports.workerd}`);
      expect((await fetch(`${s.urls.workerd}/healthz`)).ok).toBe(true);
    } finally {
      await s.stop();
      await new Promise((r) => squatter.close(r));
    }
  }, 120_000);

  it("does not retry a child that exits early for a reason other than a taken port", async () => {
    const stateDir = join(root, "state-crash");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "hub-token.json"), JSON.stringify({ token: "t" })); // skips the pairing step, which would fail first
    writeFileSync(join(stateDir, "console-hub-token.json"), JSON.stringify({ token: "t" })); // same for the console's token
    let calls = 0;
    const pickPort = async (free: () => Promise<number>) => (calls++, free());
    // An invalid NODE_OPTIONS makes every child exit at once with its own error, not a bind error.
    const s = createSupervisor({ stateDir, wolvesDir: join(root, "WolvesCrash"), runtimeDir, nodeBin: nodePath, apiKey: "sk-test-fake-key", modelBaseUrl: fakeUrl, extraEnv: { NODE_OPTIONS: "--no-such-flag" }, pickPort });
    made.push(s);
    await expect(s.start()).rejects.toThrow(/exited before it came up/);
    expect(calls).toBe(2); // hubd's and workerd's picks, once: no second attempt
  }, 60_000);

  it.sequential("replies and remembers across a restart", async () => {
    const first = make();
    await first.start();
    const chat = say(first.urls.workerd, "my secret word is PINEAPPLE");
    for (let i = 0; i < 6; i++) {
      for (const n of sockets(first.allPids(), "ESTABLISHED")) established.add(n);
      await new Promise((r) => setTimeout(r, 150));
    }
    expect(await chat).toContain("FAKE-REPLY-OK");
    await first.stop();
    writeFileSync(join(root, "state", "hub-token.json"), "{ not json"); // a torn write: the next start must set it aside and mint a fresh one

    second = make();
    await second.start();
    secondPids = second.allPids();
    const thread = await new HttpConsoleClient({ baseUrl: second.urls.workerd }).getThread("wolf/home");
    expect(thread.messages.map((m: { text: string }) => m.text)).toEqual(["my secret word is PINEAPPLE", "FAKE-REPLY-OK"]);
  }, 180_000);

  it.sequential("keeps everything on this Mac: loopback listeners and peers only, the fake model got the key, keys.env is 0600 and credentials.json is never written", () => {
    if (!second) throw new Error("the restart test did not produce a running supervisor");
    const addrs = sockets(secondPids, "LISTEN");
    for (const a of addrs) expect(a).toMatch(loopback);
    expect(addrs).toEqual(expect.arrayContaining([`127.0.0.1:${second.ports.hubd}`, `127.0.0.1:${second.ports.workerd}`]));
    for (const n of established) for (const end of n.split("->")) expect(end).toMatch(loopback);
    expect(seenKeys.at(-1)).toBe("sk-test-fake-key");
    expect(statSync(join(root, "state", "keys.env")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(root, "state", "credentials.json"))).toBe(false);
    expect(statSync(join(root, "state", "hub-token.json")).mode & 0o777).toBe(0o600);
    expect(typeof JSON.parse(readFileSync(join(root, "state", "hub-token.json"), "utf8")).token).toBe("string");
    expect(readdirSync(join(root, "state")).filter((f) => f.startsWith("hub-token.json.bad-"))).toHaveLength(1);
  });

  it("a curate() still waiting when stop() runs resolves as skipped, not hung", async () => {
    const dir = mkdtempSync(join(tmpdir(), "app-model-"));
    writeFileSync(join(dir, "model.onnx"), ""); // curation only needs the file to exist to be on
    const s = createSupervisor({ stateDir: join(root, "state-curate"), wolvesDir: join(root, "Wolves2"), runtimeDir, nodeBin: nodePath, apiKey: "sk-test-fake-key", modelBaseUrl: fakeUrl, embedModelDir: dir });
    made.push(s);
    await s.start();
    const p = s.curate();
    await s.stop();
    expect(await p).toEqual({ skipped: "hubd stopped" });
    rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it.sequential("curate() without an embedding model skips with a reason (no model dir was given: curation is off, nothing is called)", async () => {
    if (!second) throw new Error("the restart test did not produce a running supervisor");
    expect(await second.curate()).toEqual({ skipped: "no embedding model" });
  });

  it.sequential("restart(\"wolfd\") keeps the ports and hubd, hands the new key to the wolf, and stays running after the old workerd's late exit", async () => {
    const s = createSupervisor({ stateDir: join(root, "state-restart"), wolvesDir: join(root, "Wolves3"), runtimeDir, nodeBin: nodePath, apiKey: "sk-old-key", modelBaseUrl: fakeUrl });
    made.push(s);
    await s.start();
    const ports = { ...s.ports };
    const hubPid = s.allPids()[0]; // hubd is launched first
    writeFileSync(join(root, "state-restart", "keys.env"), "ANTHROPIC_API_KEY=sk-new-key\n", { mode: 0o600 });
    const first = s.restart("wolfd");
    writeFileSync(join(root, "state-restart", "keys.env"), "ANTHROPIC_API_KEY=sk-newer-key\n", { mode: 0o600 });
    await Promise.all([first, s.restart("wolfd")]); // calls run one after the other, each reading the key afresh
    expect(s.ports).toEqual(ports);
    expect(s.allPids()[0]).toBe(hubPid);
    await new Promise((r) => setTimeout(r, 500)); // the old workerd's exit event may land after the new one is up
    expect(s.status().running).toBe(true);
    expect(await say(s.urls.workerd, "hello again")).toContain("FAKE-REPLY-OK");
    expect(seenKeys.at(-1)).toBe("sk-newer-key");
    await expect(s.restart("workerd")).rejects.toThrow(/cannot restart workerd/);
  }, 180_000);

  it.sequential("restart(\"hubd\") relaunches hubd on its port with the key that keys.env holds now, where it had none before", async () => {
    const dir = join(root, "state-hubrestart");
    const s = createSupervisor({ stateDir: dir, wolvesDir: join(root, "Wolves6"), runtimeDir, nodeBin: nodePath, modelBaseUrl: fakeUrl });
    made.push(s);
    await s.start();
    const ports = { ...s.ports };
    const oldPid = hubPid(s.ports.hubd);
    expect(procEnv(oldPid)).not.toContain("ANTHROPIC_API_KEY="); // started with no key
    writeFileSync(join(dir, "keys.env"), "ANTHROPIC_API_KEY=sk-hub-second\n", { mode: 0o600 });
    await s.restart("hubd");
    expect(s.ports).toEqual(ports);
    expect(alive(oldPid)).toBe(false);
    const newPid = hubPid(s.ports.hubd);
    expect(newPid).not.toBe(oldPid);
    expect(procEnv(newPid)).toContain("ANTHROPIC_API_KEY=sk-hub-second");
    expect((await fetch(`${s.urls.hubd}/healthz`)).ok).toBe(true);
  }, 180_000);

  it.sequential("a stale credentials.json key never wins: the wolf and hubd get the key in keys.env", async () => {
    const dir = join(root, "state-stale");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "credentials.json"), "ANTHROPIC_API_KEY=sk-stale-old\n");
    writeFileSync(join(dir, "keys.env"), "ANTHROPIC_API_KEY=sk-from-keys-env\n", { mode: 0o600 });
    const s = createSupervisor({ stateDir: dir, wolvesDir: join(root, "Wolves9"), runtimeDir, nodeBin: nodePath, modelBaseUrl: fakeUrl });
    made.push(s);
    await s.start();
    const hubEnv = procEnv(hubPid(s.ports.hubd));
    expect(hubEnv).toContain("ANTHROPIC_API_KEY=sk-from-keys-env");
    expect(hubEnv).not.toContain("sk-stale-old");
    expect(await say(s.urls.workerd, "hello")).toContain("FAKE-REPLY-OK");
    expect(seenKeys.at(-1)).toBe("sk-from-keys-env");
  }, 180_000);

  /** Replace hubd's data dir with a file, so a relaunched hubd exits at once (not a bind error); put it back with the returned fn. */
  const breakHubDir = (dir: string) => {
    renameSync(join(dir, "hub"), join(dir, "hub.away"));
    writeFileSync(join(dir, "hub"), "not a directory");
    return () => {
      rmSync(join(dir, "hub"), { force: true });
      renameSync(join(dir, "hub.away"), join(dir, "hub"));
    };
  };

  it.sequential("a hubd that fails to relaunch is tried once more", async () => {
    const dir = join(root, "state-hubretry");
    let heal: (() => void) | undefined;
    let failedExits = 0;
    const log = (l: string) => {
      if (/^hubd exited \(code=[1-9]/.test(l) && ++failedExits === 1) heal?.(); // the first relaunch died: the data dir is fine for the second
    };
    const s = createSupervisor({ stateDir: dir, wolvesDir: join(root, "Wolves10"), runtimeDir, nodeBin: nodePath, apiKey: "sk-retry-key", modelBaseUrl: fakeUrl, log });
    made.push(s);
    await s.start();
    heal = breakHubDir(dir);
    await s.restart("hubd");
    expect(failedExits).toBe(1);
    expect(s.status().running).toBe(true);
    expect((await fetch(`${s.urls.hubd}/healthz`)).ok).toBe(true);
  }, 180_000);

  it.sequential("when hubd cannot come back, restart(\"wolfd\") still gives the wolf the new key and status() says the app is not fully running", async () => {
    const dir = join(root, "state-hubdown");
    const s = createSupervisor({ stateDir: dir, wolvesDir: join(root, "Wolves11"), runtimeDir, nodeBin: nodePath, apiKey: "sk-down-old", modelBaseUrl: fakeUrl });
    made.push(s);
    await s.start();
    const heal = breakHubDir(dir);
    try {
      writeFileSync(join(dir, "keys.env"), "ANTHROPIC_API_KEY=sk-down-new\n", { mode: 0o600 });
      await expect(s.restart("hubd")).rejects.toThrow(/hubd/);
      expect(s.status().running).toBe(false);
      await s.restart("wolfd");
      expect(await say(s.urls.workerd, "hello")).toContain("FAKE-REPLY-OK");
      expect(seenKeys.at(-1)).toBe("sk-down-new");
      expect(s.status().running).toBe(false); // hubd is still down
    } finally {
      heal();
    }
  }, 180_000);

  it.sequential("restart(\"hubd\") returns only once the old hubd is gone, even when it ignores SIGTERM", async () => {
    const dir = join(root, "state-hubstopped");
    let failedExits = 0;
    const log = (l: string) => {
      if (/^hubd exited \(code=[1-9]/.test(l)) failedExits++;
    };
    const s = createSupervisor({ stateDir: dir, wolvesDir: join(root, "Wolves12"), runtimeDir, nodeBin: nodePath, apiKey: "sk-stop-key", modelBaseUrl: fakeUrl, termGraceMs: 500, log });
    made.push(s);
    await s.start();
    const oldPid = hubPid(s.ports.hubd);
    process.kill(oldPid, "SIGSTOP"); // SIGTERM stays pending: only SIGKILL ends it
    await s.restart("hubd");
    expect(alive(oldPid)).toBe(false);
    expect(hubPid(s.ports.hubd)).not.toBe(oldPid);
    expect(failedExits).toBe(0); // the new hubd bound the port first time
    expect((await fetch(`${s.urls.hubd}/healthz`)).ok).toBe(true);
  }, 180_000);

  it.sequential("curate() skips while hubd is being restarted instead of signalling it", async () => {
    const modelDir = mkdtempSync(join(tmpdir(), "app-model-"));
    writeFileSync(join(modelDir, "model.onnx"), "");
    const s = createSupervisor({ stateDir: join(root, "state-curate-restart"), wolvesDir: join(root, "Wolves13"), runtimeDir, nodeBin: nodePath, apiKey: "sk-curate-key", modelBaseUrl: fakeUrl, embedModelDir: modelDir });
    made.push(s);
    await s.start();
    const restarting = s.restart("hubd");
    expect(await s.curate()).toEqual({ skipped: "hubd is restarting" });
    await restarting;
    rmSync(modelDir, { recursive: true, force: true });
  }, 180_000);

  it.sequential("a key written to keys.env behind the app's back (Pack → Keys) restarts hubd with it, and not the wolf", async () => {
    const dir = join(root, "state-packwrite");
    const s = createSupervisor({ stateDir: dir, wolvesDir: join(root, "Wolves14"), runtimeDir, nodeBin: nodePath, apiKey: "sk-pack-old", modelBaseUrl: fakeUrl, pollMs: 300 });
    made.push(s);
    await s.start();
    const oldPid = hubPid(s.ports.hubd);
    const workerdPid = s.allPids().find((p: number) => p !== oldPid && procEnv(p).includes("WORKERD_KEY_FILE="));
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(join(dir, "keys.env"), "ANTHROPIC_API_KEY=sk-pack-old\n", { mode: 0o600 }); // same key rewritten: no restart
    await new Promise((r) => setTimeout(r, 1500));
    expect(hubPid(s.ports.hubd)).toBe(oldPid);
    writeFileSync(join(dir, "keys.env"), "ANTHROPIC_API_KEY=sk-pack-new\n", { mode: 0o600 });
    let newPid = oldPid;
    for (let i = 0; i < 100 && (newPid === oldPid || !s.status().running); i++) {
      await new Promise((r) => setTimeout(r, 300));
      try {
        newPid = hubPid(s.ports.hubd);
      } catch {
        /* between the old hubd and the new */
      }
    }
    expect(newPid).not.toBe(oldPid);
    expect(alive(oldPid)).toBe(false);
    expect(procEnv(newPid)).toContain("ANTHROPIC_API_KEY=sk-pack-new");
    expect(alive(workerdPid)).toBe(true); // workerd restarts API wolves itself on a Pack save; the app does not
    expect(s.allPids()).toContain(workerdPid);
  }, 180_000);

  it("start() with an unsafe key fails with a plain message that does not contain the key, and starts nothing", async () => {
    const s = createSupervisor({ stateDir: join(root, "state-badkey"), wolvesDir: join(root, "Wolves7"), runtimeDir, nodeBin: nodePath, apiKey: 'sk-bad"key-zzz', modelBaseUrl: fakeUrl });
    made.push(s);
    const err = await s.start().then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/not allowed/);
    expect(err?.message).not.toContain("sk-bad");
    expect(s.allPids()).toEqual([]);
    expect(existsSync(join(root, "state-badkey", "keys.env"))).toBe(false);
  }, 60_000);

  it.skipIf(process.getuid?.() === 0)("start() with a keys.env it cannot read fails with a clear message and leaves the file as it was", async () => {
    const dir = join(root, "state-unreadable");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "keys.env");
    writeFileSync(file, "DEEPGRAM_API_KEY=dg-keepme\n", { mode: 0o600 });
    chmodSync(file, 0o000);
    const s = createSupervisor({ stateDir: dir, wolvesDir: join(root, "Wolves8"), runtimeDir, nodeBin: nodePath, apiKey: "sk-fresh-key", modelBaseUrl: fakeUrl });
    made.push(s);
    try {
      const err = await s.start().then(() => null, (e: Error) => e);
      expect(err?.message).toMatch(/cannot be read/);
      expect(err?.message).not.toContain("sk-fresh-key");
      expect(s.allPids()).toEqual([]);
    } finally {
      chmodSync(file, 0o600);
    }
    expect(readFileSync(file, "utf8")).toBe("DEEPGRAM_API_KEY=dg-keepme\n");
  }, 60_000);

  it.sequential("restart(\"wolfd\") with the old workerd port taken and the first new pick taken too comes up on another port and reports PORT_MOVED", async () => {
    const squatters: Server[] = [];
    const squat = async (port = 0) => {
      const sq = createNetServer((sock) => sock.destroy());
      await new Promise<void>((r) => sq.listen(port, "127.0.0.1", r));
      squatters.push(sq);
      return (sq.address() as { port: number }).port;
    };
    const takenPick = await squat();
    let restarting = false;
    let restartPicks = 0;
    const pickPort = async (free: () => Promise<number>) => (restarting && ++restartPicks === 1 ? takenPick : free());
    const s = createSupervisor({ stateDir: join(root, "state-restart-busy"), wolvesDir: join(root, "Wolves4"), runtimeDir, nodeBin: nodePath, apiKey: "sk-test-fake-key", modelBaseUrl: fakeUrl, pickPort });
    made.push(s);
    try {
      await s.start();
      const old = s.ports.workerd;
      const hub = s.ports.hubd;
      const oldWorkerd = s.allPids()[1];
      process.kill(oldWorkerd, "SIGTERM");
      for (let i = 0; i < 50 && alive(oldWorkerd); i++) await new Promise((r) => setTimeout(r, 100));
      await squat(old); // someone else grabbed the old port
      restarting = true;
      await expect(s.restart("wolfd")).rejects.toMatchObject({ code: "PORT_MOVED" });
      expect(s.ports.hubd).toBe(hub);
      expect(s.ports.workerd).not.toBe(old);
      expect(s.ports.workerd).not.toBe(takenPick);
      expect(s.urls.workerd).toBe(`http://127.0.0.1:${s.ports.workerd}`);
      expect((await fetch(`${s.urls.workerd}/healthz`)).ok).toBe(true);
    } finally {
      await s.stop();
      for (const sq of squatters) await new Promise((r) => sq.close(r));
    }
  }, 180_000);

  it.sequential("starts with no API key: services run with no key in their env, the chat says to add one in Pack → Keys, and the key added later reaches the wolf after restart(\"wolfd\")", async () => {
    const s = createSupervisor({ stateDir: join(root, "state-nokey"), wolvesDir: join(root, "Wolves4"), runtimeDir, nodeBin: nodePath, modelBaseUrl: fakeUrl });
    made.push(s);
    await s.start();
    expect(s.status().running).toBe(true);
    const before = seenKeys.length;
    const c = new HttpConsoleClient({ baseUrl: s.urls.workerd });
    await c.submit("wolf/home", "hello", { whenBusy: "reject" });
    let error = "";
    for await (const e of c.watch("wolf/home")) if (e.type === "error") error = e.message;
    expect(error).toBe("No API key yet. Add one in Pack → Keys, then send again.");
    expect(seenKeys.length).toBe(before); // nothing went out to the model
    writeFileSync(join(root, "state-nokey", "keys.env"), "ANTHROPIC_API_KEY=sk-added-later\n", { mode: 0o600 });
    await s.restart("wolfd");
    expect(await say(s.urls.workerd, "hello again")).toContain("FAKE-REPLY-OK");
    expect(seenKeys.at(-1)).toBe("sk-added-later");
  }, 180_000);

  it("started with no key, curate() skips with a reason", async () => {
    const dir = mkdtempSync(join(tmpdir(), "app-model-"));
    writeFileSync(join(dir, "model.onnx"), "");
    const s = createSupervisor({ stateDir: join(root, "state-nokey-curate"), wolvesDir: join(root, "Wolves5"), runtimeDir, nodeBin: nodePath, modelBaseUrl: fakeUrl, embedModelDir: dir });
    made.push(s);
    await s.start();
    expect(await s.curate()).toEqual({ skipped: "no API key" }); // returns at once: no SIGUSR2 window, so nothing waits for hubd's 'window done' line
    rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it.sequential("registers this Mac with its own hubd: workerd/hub.json has the host id and a token different from hub-token.json; a corrupt hub.json is set aside; a second start keeps both", async () => {
    const dir = join(root, "state-register");
    const make2 = () => {
      const s = createSupervisor({ stateDir: dir, wolvesDir: join(root, "Wolves7"), runtimeDir, nodeBin: nodePath, apiKey: "sk-test-fake-key", modelBaseUrl: fakeUrl });
      made.push(s);
      return s;
    };
    const hubJson = join(dir, "workerd", "hub.json");
    const first = make2();
    await first.start();
    const cfg = JSON.parse(readFileSync(hubJson, "utf8"));
    expect(cfg.hostId).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(cfg.hubUrl).toBe(first.urls.hubd);
    expect(typeof cfg.token).toBe("string");
    expect(cfg.token).not.toBe(JSON.parse(readFileSync(join(dir, "hub-token.json"), "utf8")).token);
    expect(statSync(hubJson).mode & 0o777).toBe(0o600);
    // the machine is connected to the hub: its hello public key is listed under its host id
    const bearer = `Bearer ${JSON.parse(readFileSync(join(dir, "hub-token.json"), "utf8")).token}`;
    let hosts: string[] = [];
    for (let i = 0; i < 40 && !hosts.includes(cfg.hostId); i++) {
      hosts = Object.keys(((await (await fetch(`${first.urls.hubd}/v1/machines/keys`, { headers: { authorization: bearer } })).json()) as { keys?: Record<string, unknown> }).keys ?? {});
      if (!hosts.includes(cfg.hostId)) await new Promise((r) => setTimeout(r, 250));
    }
    expect(hosts).toContain(cfg.hostId);
    // the console's direct path (health probe workerd-direct) answers: workerd serves /direct/v1 only once it has a hub config and a token file in its config dir
    const direct = await fetch(`${first.urls.workerd}/direct/v1/wolves`, { headers: { "x-wolfpack-direct-token": readFileSync(join(dir, "workerd", "direct-token"), "utf8").trim() } });
    expect(direct.status).toBe(200);
    await first.stop();

    const second2 = make2();
    await second2.start();
    expect(JSON.parse(readFileSync(hubJson, "utf8")).token).toBe(cfg.token); // kept, not re-paired
    await second2.stop();

    writeFileSync(hubJson, "{ not json");
    const third = make2();
    await third.start();
    expect(readdirSync(join(dir, "workerd")).filter((f) => f.startsWith("hub.json.bad-"))).toHaveLength(1);
    expect(JSON.parse(readFileSync(hubJson, "utf8")).hostId).toBe(cfg.hostId);
    await third.stop();
  }, 240_000);

  it.sequential("mints a separate console token: its own file, different from the wolf's, accepted by hubd, and a corrupt file is set aside", async () => {
    const dir = join(root, "state-consoletoken");
    const mk = () => {
      const s = createSupervisor({ stateDir: dir, wolvesDir: join(root, "Wolves8"), runtimeDir, nodeBin: nodePath, apiKey: "sk-test-fake-key", modelBaseUrl: fakeUrl });
      made.push(s);
      return s;
    };
    const file = join(dir, "console-hub-token.json");
    const first = mk();
    await first.start();
    const stored = JSON.parse(readFileSync(file, "utf8")).token;
    expect(first.consoleToken).toBe(stored);
    expect(stored).not.toBe(JSON.parse(readFileSync(join(dir, "hub-token.json"), "utf8")).token);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const res = await fetch(`${first.urls.hubd}/v1/machines/keys`, { headers: { authorization: `Bearer ${stored}` } });
    expect(res.status).toBe(200);
    await first.stop();
    writeFileSync(file, "{ not json");
    const second = mk();
    await second.start();
    expect(readdirSync(dir).filter((f) => f.startsWith("console-hub-token.json.bad-"))).toHaveLength(1);
    expect(second.consoleToken).toBe(JSON.parse(readFileSync(file, "utf8")).token);
    await second.stop();
  }, 180_000);

  it.sequential("a stored hub token hubd no longer accepts is set aside and the Mac pairs again", async () => {
    const dir = join(root, "state-hubreset");
    const mk = () => {
      const s = createSupervisor({ stateDir: dir, wolvesDir: join(root, "Wolves15"), runtimeDir, nodeBin: nodePath, apiKey: "sk-test-fake-key", modelBaseUrl: fakeUrl });
      made.push(s);
      return s;
    };
    const first = mk();
    await first.start();
    const before = JSON.parse(readFileSync(join(dir, "workerd", "hub.json"), "utf8"));
    await first.stop();
    rmSync(join(dir, "hub", "auth", "tokens.json"), { force: true }); // the hub's data was reset: every stored token is now unknown to it
    const second = mk();
    await second.start();
    const after = JSON.parse(readFileSync(join(dir, "workerd", "hub.json"), "utf8"));
    expect(after.token).not.toBe(before.token);
    expect(after.hostId).toBe(before.hostId);
    expect(readdirSync(join(dir, "workerd")).filter((f) => f.startsWith("hub.json.stale-"))).toHaveLength(1);
    expect(readdirSync(dir).filter((f) => f.startsWith("hub-token.json.stale-"))).toHaveLength(1);
    expect(readdirSync(dir).filter((f) => f.startsWith("console-hub-token.json.stale-"))).toHaveLength(1);
    for (const token of [second.consoleToken, JSON.parse(readFileSync(join(dir, "hub-token.json"), "utf8")).token]) {
      expect((await fetch(`${second.urls.hubd}/v1/machines/keys`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    }
    // a worker token may not read machine keys (403), but hubd knows it (not 401)
    expect((await fetch(`${second.urls.hubd}/v1/machines/keys`, { headers: { authorization: `Bearer ${after.token}` } })).status).toBe(403);
    await second.stop();
  }, 180_000);

  it.sequential("a Mac renamed after first run keeps reporting under its stored host id", async () => {
    const dir = join(root, "state-renamed");
    const mk = (name: string) => {
      const s = createSupervisor({ stateDir: dir, wolvesDir: join(root, "Wolves16"), runtimeDir, nodeBin: nodePath, apiKey: "sk-test-fake-key", modelBaseUrl: fakeUrl, hostname: () => name });
      made.push(s);
      return s;
    };
    const machineOf = (s: ReturnType<typeof createSupervisor>) => {
      const pid = s.allPids().find((p: number) => procEnv(p).includes("WORKERD_KEY_FILE="));
      return /WOLFPACK_MACHINE=(\S+)/.exec(procEnv(pid))?.[1];
    };
    const first = mk("Old-Name.local");
    await first.start();
    expect(machineOf(first)).toBe("old-name");
    await first.stop();
    const second = mk("New-Name.local");
    await second.start();
    expect(JSON.parse(readFileSync(join(dir, "workerd", "hub.json"), "utf8")).hostId).toBe("old-name");
    expect(machineOf(second)).toBe("old-name");
    await second.stop();
  }, 180_000);

  it.sequential("workerd gets the app's plugins dir", async () => {
    const dir = join(root, "state-plugins");
    const s = createSupervisor({ stateDir: dir, wolvesDir: join(root, "Wolves17"), runtimeDir, nodeBin: nodePath, apiKey: "sk-test-fake-key", modelBaseUrl: fakeUrl });
    made.push(s);
    await s.start();
    const pid = s.allPids().find((p: number) => procEnv(p).includes("WORKERD_KEY_FILE="));
    expect(procEnv(pid)).toContain(`WOLFPACK_PLUGINS_DIR=${join(dir, "plugins")}`);
    expect(statSync(join(dir, "plugins")).isDirectory()).toBe(true);
  }, 180_000);

  it.sequential("the curator reads its own models file, so editing the wolf's models.json never touches curation", async () => {
    const dir = join(root, "state-curator-models");
    const wolves = join(root, "Wolves18");
    const mk = () => {
      const s = createSupervisor({ stateDir: dir, wolvesDir: wolves, runtimeDir, nodeBin: nodePath, apiKey: "sk-test-fake-key", modelBaseUrl: fakeUrl });
      made.push(s);
      return s;
    };
    const s = mk();
    await s.start();
    const curatorFile = join(wolves, "wolf", "models.curator.json");
    expect(procEnv(hubPid(s.ports.hubd))).toContain(`HUBD_CURATOR_MODELS=${curatorFile}`);
    expect(JSON.parse(readFileSync(curatorFile, "utf8")).tiers.fast).toMatchObject({ provider: "anthropic", piModel: expect.stringMatching(/^anthropic\//) });
    await s.stop();
    // the owner (or Claude Code) moves the wolf to the plug-in; a restart keeps that and leaves the curator's file alone
    const wolfModels = join(wolves, "wolf", "models.json");
    const m = JSON.parse(readFileSync(wolfModels, "utf8"));
    m.tiers.main.provider = "claude-subscription";
    writeFileSync(wolfModels, JSON.stringify(m));
    const again = mk();
    await again.start();
    expect(JSON.parse(readFileSync(wolfModels, "utf8")).tiers.main.provider).toBe("claude-subscription");
    expect(JSON.parse(readFileSync(curatorFile, "utf8")).tiers.main.provider).toBe("anthropic");
  }, 180_000);

  it.sequential("leaves no child process after stop", async () => {
    await second?.stop();
    for (const pid of secondPids) expect(alive(pid)).toBe(false);
    expect(await second?.curate()).toEqual({ skipped: "hubd is not running" });
  }, 60_000);
});
