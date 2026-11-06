/** P2 end to end against a REAL hubd process (compiled CLI, temp data dir) behind a prefix-stripping proxy: pair -> exchange -> forwarded call -> revoke -> 401. */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_DOMAIN, seedFixture } from "./testing/fixture.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
let dir = "";
let child: ChildProcess;
let proxy: Server;
let hubPort = 0;
let publicUrl = "";
const run = (...a: string[]) => spawnSync(process.execPath, [cli, ...a], { encoding: "utf8", env: { PATH: process.env.PATH, HUBD_PUBLIC_URL: publicUrl } });
const freePort = () => new Promise<number>((res) => { const s = netServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });

beforeAll(async () => {
  if (!existsSync(cli)) throw new Error(`${cli} is missing: run \`npx tsc --build\` first`);
  dir = mkdtempSync(join(tmpdir(), "hubd-devpair-"));
  seedFixture(dir);
  hubPort = await freePort();
  // the public face: /hub/* -> hubd with the prefix stripped (what `tailscale serve --set-path /hub` does)
  proxy = createServer(async (req, res) => {
    const path = (req.url ?? "/").replace(/^\/hub/, "") || "/";
    const body = req.method === "POST" ? await new Promise<Buffer>((r) => { const c: Buffer[] = []; req.on("data", (d) => c.push(d)); req.on("end", () => r(Buffer.concat(c))); }) : undefined;
    const up = await fetch(`http://127.0.0.1:${hubPort}${path}`, { method: req.method, headers: { ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}), "content-type": "application/json" }, ...(body ? { body } : {}) });
    res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "text/plain" });
    res.end(Buffer.from(await up.arrayBuffer()));
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  publicUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}/hub`;
  child = spawn(process.execPath, [cli, "serve", "--data-dir", dir, "--port", String(hubPort)], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH } });
  await new Promise<void>((ok, bad) => {
    const t = setTimeout(() => bad(new Error("hubd did not start")), 20_000);
    child.stdout!.on("data", (d: Buffer) => { if (String(d).includes("hubd listening")) { clearTimeout(t); ok(); } });
    child.on("exit", () => bad(new Error("hubd exited")));
  });
}, 30_000);
afterAll(async () => {
  if (child && child.exitCode === null) await new Promise<void>((r) => { child.once("exit", () => r()); child.kill(); });
  proxy?.closeAllConnections();
  proxy?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("device pairing against a real hubd", () => {
  it("pair -> exchange -> forwarded call accepted -> tokens list -> revoke -> 401", async () => {
    const p = run("pair", "--kind", "browser", "--label", "Luka's phone", "--data-dir", dir);
    expect(p.status).toBe(0);
    const link = /(http\S+\/hub\/pair\?code=\S+)/.exec(p.stdout)![1]!;
    expect(p.stdout).toMatch(/[█▀▄]/);
    // the QR link opens the pairing page through the stripped prefix; the page posts to <page path>/../v1/pair
    const page = await fetch(link);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('location.pathname.replace(/\\/pair\\/?$/,"/v1/pair")');
    const code = new URL(link).searchParams.get("code")!;
    const ex = await fetch(new URL("v1/pair", link.split("?")[0]!.replace(/pair$/, "")), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, label: "ignored", kind: "browser" }) });
    expect(ex.status).toBe(200);
    const { token, tokenId } = (await ex.json()) as { token: string; tokenId: string };
    const call = () => fetch(`${publicUrl}/v1/work?domain=${FIXTURE_DOMAIN}`, { headers: { Authorization: `Bearer ${token}` } });
    expect((await call()).status).toBe(200); // forwarded verbatim through the proxy
    expect((await fetch(`${publicUrl}/v1/work?domain=${FIXTURE_DOMAIN}`)).status).toBe(401);
    const list = run("tokens", "list", "--data-dir", dir).stdout;
    expect(list).toContain(tokenId);
    expect(list).toMatch(/browser\s+Luka's phone/);
    expect(list).not.toContain(token);
    expect((await fetch(`${publicUrl}/v1/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, label: "x", kind: "browser" }) })).status).toBe(401);
    expect(run("tokens", "revoke", tokenId, "--data-dir", dir).status).toBe(0);
    expect((await call()).status).toBe(401);
  }, 30_000);
});
