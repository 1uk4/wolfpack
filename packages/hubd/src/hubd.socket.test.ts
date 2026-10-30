import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { LINK_PATH } from "@wolfpack/protocol";
import { createTokenStore } from "./auth.js";
import { main, parseArgs } from "./cli.js";
import { createHubServer, type HubServer } from "./server.js";
import { listenOnSocket, parseSocketMode, removeSocket } from "./socket.js";
import { FIXTURE_DOMAIN, seedFixture } from "./testing/fixture.js";

const dirs: string[] = [];
const hubs: HubServer[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "hs-"));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const start = async (extra: { socketMode?: number } = {}, sock?: string) => {
  const dataDir = tmp();
  seedFixture(dataDir);
  const socketPath = sock ?? join(tmp(), "h.sock");
  const hub = await createHubServer({ dataDir, apiKey: "k", socketPath, ...extra });
  hubs.push(hub);
  return { hub, socketPath };
};
const get = (socketPath: string, path: string, key = "k") =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const r = request({ socketPath, path, headers: { "X-API-Key": key } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    r.on("error", reject);
    r.end();
  });

describe("hubd unix socket", () => {
  it("serves requests over the socket, with auth still enforced", async () => {
    const { socketPath, hub } = await start();
    expect(hub.url).toBe(`unix:${socketPath}`);
    expect((await get(socketPath, `/v1/work?domain=${FIXTURE_DOMAIN}`)).status).toBe(200);
    expect((await get(socketPath, `/v1/work?domain=${FIXTURE_DOMAIN}`, "wrong")).status).toBe(401);
  });

  it("socket mode is 0660 by default, honours 0600, and is never world-accessible", async () => {
    const a = await start();
    expect(statSync(a.socketPath).mode & 0o777).toBe(0o660);
    const b = await start({ socketMode: 0o600 });
    expect(statSync(b.socketPath).mode & 0o777).toBe(0o600);
    await expect(start({ socketMode: 0o666 })).rejects.toThrow(/world-accessible/);
    await expect(start({ socketMode: 0o400 })).rejects.toThrow(/owner/);
  });

  it("removes the socket on close", async () => {
    const { hub, socketPath } = await start();
    expect(existsSync(socketPath)).toBe(true);
    await hub.close();
    expect(existsSync(socketPath)).toBe(false);
  });

  it("replaces a stale socket left by a dead process", async () => {
    const p = join(tmp(), "stale.sock");
    const s = netServer();
    await new Promise<void>((r) => s.listen(p, r));
    // Simulate a crash: the file stays, nobody listens.
    (s as unknown as { _handle: { close(): void } })._handle.close();
    const { socketPath } = await start({}, p);
    expect((await get(socketPath, `/v1/work?domain=${FIXTURE_DOMAIN}`)).status).toBe(200);
  });

  it("refuses a socket a live process holds, and a regular file, leaving both alone", async () => {
    const p = join(tmp(), "live.sock");
    const live = createServer((_q, r) => r.end("x"));
    await new Promise<void>((r) => live.listen(p, r));
    await expect(start({}, p)).rejects.toThrow(/in use/);
    expect((await get(p, "/")).body).toBe("x");
    live.close();
    const f = join(tmp(), "file.sock");
    writeFileSync(f, "data");
    await expect(start({}, f)).rejects.toThrow(/not a socket/);
    expect(existsSync(f)).toBe(true);
  });

  it("rejects socketPath together with port or host, and relative paths", async () => {
    const dataDir = tmp();
    await expect(createHubServer({ dataDir, socketPath: "/tmp/x.sock", port: 3999 })).rejects.toThrow(/cannot be combined/);
    await expect(createHubServer({ dataDir, socketPath: "/tmp/x.sock", host: "127.0.0.1" })).rejects.toThrow(/cannot be combined/);
    await expect(createHubServer({ dataDir, socketPath: "rel.sock" })).rejects.toThrow(/absolute/);
  });
});

describe("hubd unix socket: hardening", () => {
  it("removeSocket unlinks only the exact inode it bound, never a replacement or a non-socket", async () => {
    const { hub, socketPath } = await start();
    const st = lstatSync(socketPath);
    const id = { dev: st.dev, ino: st.ino };
    // (Node/libuv itself unlinks the path on server.close(), outside our control; this tests our own removal.)
    removeSocket(socketPath, undefined);
    expect(existsSync(socketPath)).toBe(true); // no identity: never unlinks
    removeSocket(socketPath, { dev: id.dev, ino: id.ino + 1 });
    expect(existsSync(socketPath)).toBe(true); // other inode: left alone
    const other = join(tmp(), "o.sock");
    const o = netServer();
    await new Promise<void>((r) => o.listen(other, r));
    removeSocket(other, id);
    expect(existsSync(other)).toBe(true); // a different socket with a different identity survives
    o.close();
    removeSocket(socketPath, id);
    expect(existsSync(socketPath)).toBe(false); // the matching one goes
    await hub.close();
  });

  it("refuses a symlink at the socket path and leaves it", async () => {
    const d = tmp();
    const target = join(d, "target");
    writeFileSync(target, "x");
    const link = join(d, "h.sock");
    symlinkSync(target, link);
    await expect(start({}, link)).rejects.toThrow(/not a socket/);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("refuses a world-writable parent without the sticky bit, allows sticky", async () => {
    const d = tmp();
    chmodSync(d, 0o777);
    await expect(listenOnSocket(netServer(), join(d, "h.sock"), 0o600)).rejects.toThrow(/world-writable/);
    chmodSync(d, 0o1777);
    const { socketPath } = await start({}, join(d, "h.sock"));
    expect(existsSync(socketPath)).toBe(true);
  });

  it("serves the worker link (WebSocket upgrade) over the socket, auth enforced", async () => {
    const { socketPath } = await start();
    const url = `ws+unix://${socketPath}:${LINK_PATH}`;
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(url, { headers: { Authorization: "Bearer nope" } });
      ws.on("unexpected-response", (_q, res) => resolve(res.statusCode ?? 0));
      ws.on("error", () => {});
    });
    expect(status).toBe(401);
    const dir = hubs[0]!.dataDir;
    const store = createTokenStore(dir);
    const { code } = store.mintPairingCode({ kind: "worker", hostId: "h1" });
    const { token } = store.redeem(code, "t", "worker", "h1");
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    await new Promise<void>((res, rej) => (ws.once("open", () => res()), ws.once("error", rej)));
    const first = new Promise<string>((res) => ws.once("message", (m) => res(String(m))));
    ws.send(JSON.stringify({ t: "hello", v: 1, hostId: "h1", laptop: false, wolves: [], kbRevisions: {} }));
    expect(JSON.parse(await first).t).toBe("welcome");
    ws.terminate();
  });
});

describe("hubd serve env", () => {
  it("HUBD_SOCKET / HUBD_SOCKET_MODE select the socket and its mode", async () => {
    const dataDir = tmp();
    seedFixture(dataDir);
    const sock = join(tmp(), "e.sock");
    const hub = (await main(["serve", "--data-dir", dataDir], { HUBD_SOCKET: sock, HUBD_SOCKET_MODE: "0600" } as NodeJS.ProcessEnv, () => {}))!;
    hubs.push(hub);
    expect(statSync(sock).mode & 0o777).toBe(0o600);
    expect(hub.url).toBe(`unix:${sock}`);
  });
  it("HUBD_SOCKET_MODE without a socket errors; HUBD_SOCKET with --port errors", async () => {
    const dataDir = tmp();
    await expect(main(["serve", "--data-dir", dataDir], { HUBD_SOCKET_MODE: "0660" } as NodeJS.ProcessEnv, () => {})).rejects.toThrow(/needs a unix socket/);
    await expect(main(["serve", "--data-dir", dataDir, "--port", "4000"], { HUBD_SOCKET: "/tmp/x.sock" } as NodeJS.ProcessEnv, () => {})).rejects.toThrow(/pick TCP or a unix socket/);
  });
});

describe("hubd serve config: TCP xor socket", () => {
  const base = ["serve", "--data-dir", "/tmp/d"];
  it("accepts a socket alone and plain TCP defaults (never 3141)", () => {
    const s = parseArgs([...base, "--socket", "/tmp/h.sock", "--socket-mode", "0600"]);
    expect(s.socket).toBe("/tmp/h.sock");
    expect(s.socketMode).toBe(0o600);
    const t = parseArgs(base);
    expect(t.socket).toBeUndefined();
    expect(t.port).not.toBe(3141);
  });
  it("refuses socket with --port or --host", () => {
    expect(() => parseArgs([...base, "--socket", "/tmp/h.sock", "--port", "4000"])).toThrow(/pick TCP or a unix socket/);
    expect(() => parseArgs([...base, "--host", "127.0.0.1", "--socket", "/tmp/h.sock"])).toThrow(/pick TCP or a unix socket/);
  });
  it("refuses socket-mode without socket, unsafe modes, relative paths", () => {
    expect(() => parseArgs([...base, "--socket-mode", "0660"])).toThrow(/needs --socket/);
    expect(() => parseArgs([...base, "--socket", "/tmp/h.sock", "--socket-mode", "0666"])).toThrow(/world-accessible/);
    expect(() => parseArgs([...base, "--socket", "h.sock"])).toThrow(/absolute/);
    expect(() => parseSocketMode("rw")).toThrow(/octal/);
  });
});
