import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "./cli.js";
import { createHubServer, type HubServer } from "./server.js";
import { parseSocketMode } from "./socket.js";
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
