/**
 * Seam: the app supervisor (electron/supervisor.cjs), driven from Node with temp dirs and a fake Anthropic server on
 * 127.0.0.1. Real hubd, workerd and wolfd children run from the bundles in apps/desktop/runtime.
 * Needs `node apps/desktop/scripts/build-runtime.mjs` first. The children run under Electron's own Node (the electron
 * binary in node_modules) unless WOLFPACK_DESKTOP_TEST_NODE=1 selects this process's Node (CI has no Electron binary).
 * The three tests share one run: start, chat, stop, start again (test 1); inspect it while up (test 2); stop it (test 3).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
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

    second = make();
    await second.start();
    secondPids = second.allPids();
    const thread = await new HttpConsoleClient({ baseUrl: second.urls.workerd }).getThread("wolf/home");
    expect(thread.messages.map((m: { text: string }) => m.text)).toEqual(["my secret word is PINEAPPLE", "FAKE-REPLY-OK"]);
  }, 180_000);

  it.sequential("keeps everything on this Mac: loopback listeners and peers only, the fake model got the key, credentials are 0600", () => {
    if (!second) throw new Error("the restart test did not produce a running supervisor");
    const addrs = sockets(secondPids, "LISTEN");
    for (const a of addrs) expect(a).toMatch(loopback);
    expect(addrs).toEqual(expect.arrayContaining([`127.0.0.1:${second.ports.hubd}`, `127.0.0.1:${second.ports.workerd}`]));
    for (const n of established) for (const end of n.split("->")) expect(end).toMatch(loopback);
    expect(seenKeys.at(-1)).toBe("sk-test-fake-key");
    expect(statSync(join(root, "state", "credentials.json")).mode & 0o777).toBe(0o600);
  });

  it.sequential("leaves no child process after stop", async () => {
    await second?.stop();
    for (const pid of secondPids) expect(alive(pid)).toBe(false);
  }, 60_000);
});
