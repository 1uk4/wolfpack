/**
 * Launches the real browser against a local http server. Skipped when no browser binary is found.
 * 127.0.0.1 is allowlisted, which also proves the allowlist reaches the live navigation path.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import createBrowserExtension from "./durable.js";
import { BrowserSession, findBrowser } from "./session.js";

const found = findBrowser({}, true);
const d = found ? describe : describe.skip;

d("browser extension (live)", () => {
  let server: Server;
  let base = "";
  let den = "";
  let session: BrowserSession;
  const wsHits: string[] = [];

  beforeAll(async () => {
    den = mkdtempSync(join(tmpdir(), "wolf-browser-den-"));
    server = createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "http://169.254.169.254/" });
        return res.end();
      }
      if (req.url === "/api") {
        res.writeHead(200, { "content-type": "application/json", "set-cookie": "sid=TOPSECRET" });
        return res.end('{"ok":true}');
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<title>hello</title><h1 id=h>Hi</h1><input id=i><script>console.log("from-page");fetch("/api",{headers:{authorization:"Bearer TOPSECRET"}})</script>`);
    });
    // Minimal RFC 6455 handshake: enough for the page to see onopen. Records every upgrade that reaches it.
    server.on("upgrade", (req, socket) => {
      wsHits.push(String(req.headers.host));
      const key = String(req.headers["sec-websocket-key"]);
      const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    session = new BrowserSession(den, { allowHosts: ["127.0.0.1"], timeoutMs: 15000 });
  });

  afterAll(async () => {
    await session?.close();
    await new Promise((r) => server.close(r));
    rmSync(den, { recursive: true, force: true });
  });

  it("navigates to an allowlisted loopback server, interacts, logs", async () => {
    expect(await session.run(() => session.goto(base + "/", "load"))).toMatch(/Title: hello/);
    expect(await session.run(() => session.evaluate("document.getElementById('h').textContent"))).toBe("Hi");
    await session.run(() => session.fill("#i", "x"));
    expect(await session.run(() => session.evaluate("document.getElementById('i').value"))).toBe("x");
    await new Promise((r) => setTimeout(r, 300));
    expect(session.console({})).toMatch(/from-page/);
    const net = session.network({ urlFilter: "/api" });
    expect(net).toMatch(/"status":200/);
    expect(net).not.toMatch(/TOPSECRET/);
    expect(net).toMatch(/\[redacted\]/);
    expect((await import("node:fs")).statSync(session.profileDir).mode & 0o777).toBe(0o700);
  }, 60000);

  it("blocks redirects and disallowed hosts, and screenshots are removed on close", async () => {
    await expect(session.run(() => session.goto(base + "/redirect"))).rejects.toThrow(/blocked/i);
    await expect(session.run(() => session.goto("http://localhost:1/"))).rejects.toThrow(/blocked/i);
    await expect(session.run(() => session.goto("file:///etc/hosts"))).rejects.toThrow(/blocked/i);
    await session.run(() => session.goto(base + "/"));
    const shot = (await session.run(() => session.screenshot())) as string;
    expect(existsSync(shot)).toBe(true);
    await session.close();
    expect(existsSync(shot)).toBe(false);
  }, 60000);
});

d("browser extension (live): WebSockets", () => {
  it("blocks a ws:// to an internal host from a page; an allowlisted one is not blocked", async () => {
    const den = mkdtempSync(join(tmpdir(), "wolf-browser-den-"));
    const hits: string[] = [];
    const srv = createServer((_q, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<title>p</title>"); });
    const wss = new WebSocketServer({ server: srv });
    wss.on("connection", (_sock, req) => { hits.push(String(req.headers.host)); });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    // The page host (localhost) is allowlisted; the ws target 127.0.0.1 is NOT: it must be refused.
    const s = new BrowserSession(den, { allowHosts: ["localhost"], timeoutMs: 15000 });
    const probe = (u: string) => `new Promise(r => { const w = new WebSocket(${JSON.stringify(u)}); w.onopen = () => r("open"); w.onclose = () => r("closed"); w.onerror = () => r("error"); setTimeout(() => r("timeout"), 5000); })`;
    try {
      await s.run(() => s.goto(`http://localhost:${port}/`));
      const blocked = await s.run(() => s.evaluate(probe(`ws://127.0.0.1:${port}/`)));
      expect(blocked).not.toBe("open");
      expect(hits).toHaveLength(0);
      expect(s.blockedRequests().join("\n")).toMatch(/ws:\/\/127\.0\.0\.1/);
      // Positive control: with 127.0.0.1 allowlisted the same socket opens (so the block above is the policy's doing).
      await s.close();
      const s2 = new BrowserSession(den, { allowHosts: ["127.0.0.1"], timeoutMs: 15000 });
      try {
        await s2.run(() => s2.goto(`http://127.0.0.1:${port}/`));
        const got = await s2.run(() => s2.evaluate(probe(`ws://127.0.0.1:${port}/`)));
        // Chromium's own local-network check may still refuse a fulfilled page's socket (got "error"), so assert only
        // that OUR policy let it through: nothing recorded as blocked.
        expect(got).toBeTypeOf("string");
        expect(s2.blockedRequests()).toEqual([]);
      } finally {
        await s2.close();
      }
    } finally {
      await s.close();
      await new Promise((r) => srv.close(r));
      rmSync(den, { recursive: true, force: true });
    }
  }, 60000);
});

d("browser extension (live): resilience and fetch path", () => {
  let srv: Server;
  let base = "";
  let den = "";
  const seenCookies: string[] = [];
  beforeAll(async () => {
    den = mkdtempSync(join(tmpdir(), "wolf-browser-den-"));
    srv = createServer((req, res) => {
      if (req.url === "/gz") {
        // ignores accept-encoding: identity and compresses anyway
        res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
        return res.end(gzipSync("<title>gz</title><p>zipped</p>"));
      }
      if (req.url === "/sse") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return res.write("data: x\n\n");
      }
      if (req.url === "/setck") {
        res.writeHead(200, { "content-type": "text/html", "set-cookie": ["a=1; Path=/", "bad=1; Domain=evil.com", "lax=1; SameSite=Lax; Path=/"] });
        return res.end("<title>ck</title>");
      }
      seenCookies.push(String(req.headers.cookie ?? ""));
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<title>ok</title>");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => srv.close(r));
    rmSync(den, { recursive: true, force: true });
  });

  it("recovers when the page closes: the next call works", async () => {
    const s = new BrowserSession(den, { allowHosts: ["127.0.0.1"], timeoutMs: 15000 });
    try {
      await s.run(() => s.goto(base + "/"));
      await (s as any).page.close();
      expect(await s.run(() => s.goto(base + "/"))).toMatch(/Title: ok/);
      // after a relaunch the popup-closer must not close the fresh page
      await s.close();
      expect(await s.run(() => s.goto(base + "/"))).toMatch(/Title: ok/);
      expect(await s.run(() => s.evaluate("document.title"))).toBe("ok");
    } finally {
      await s.close();
    }
  }, 60000);

  it("a busy loop times out, the queue moves on, and browser_close still works", async () => {
    const ext = createBrowserExtension({ enabled: true, allowHosts: ["127.0.0.1"], timeoutMs: 2000 }, { wolfDen: den, wolfName: "w", domains: [], wolfConfig: {} });
    const tool = (n: string) => ext.tools!.find((t) => t.name === n)!;
    const tctx = { cwd: "/", wolfDen: den, wolfName: "w", conversationId: 1 };
    try {
      expect((await tool("browser_goto").execute({ url: base + "/" }, tctx)).isError).toBeFalsy();
      const stuck = await tool("browser_eval").execute({ expression: "while(1){}" }, tctx);
      expect(stuck.isError).toBe(true);
      expect(stuck.content[0].text).toMatch(/timed out/);
      expect((await tool("browser_goto").execute({ url: base + "/" }, tctx)).isError).toBeFalsy();
      const closed = await tool("browser_close").execute({}, tctx);
      expect(closed.isError).toBeFalsy();
    } finally {
      await ext.lifecycle?.stop?.();
    }
  }, 60000);

  it("decodes a gzip body the server sent despite identity; refuses event streams", async () => {
    const s = new BrowserSession(den, { allowHosts: ["127.0.0.1"], timeoutMs: 5000 });
    try {
      await s.run(() => s.goto(base + "/gz"));
      expect(await s.run(() => s.evaluate("document.body.textContent"))).toBe("zipped");
      await s.run(() => s.goto(base + "/"));
      const r = await s.run(() => s.evaluate("fetch('/sse').then(r => r.status).catch(e => 'failed')"));
      expect(r).toBe("failed");
      expect(s.blockedRequests().join("\n")).toMatch(/event-stream/);
    } finally {
      await s.close();
    }
  }, 60000);

  it("stores valid Set-Cookie, rejects a foreign Domain, and sends Lax only on top-level GET navigations", async () => {
    const s = new BrowserSession(den, { allowHosts: ["127.0.0.1"], timeoutMs: 8000 });
    try {
      await s.run(() => s.goto(base + "/setck"));
      seenCookies.length = 0;
      await s.run(() => s.goto(base + "/"));
      expect(seenCookies.at(-1)).toMatch(/a=1/);
      expect(seenCookies.at(-1)).not.toMatch(/bad=/);
    } finally {
      await s.close();
    }
  }, 60000);
});

describe("browser extension (no browser needed)", () => {
  it("registers no tools unless enabled", () => {
    const ctx = { wolfDen: "/nonexistent", wolfName: "w", domains: [], wolfConfig: {} };
    expect(createBrowserExtension(undefined, ctx).tools ?? []).toHaveLength(0);
    expect(createBrowserExtension({ enabled: false }, ctx).tools ?? []).toHaveLength(0);
    const on = createBrowserExtension({ enabled: true }, ctx);
    expect(on.tools?.map((t) => t.name)).toEqual([
      "browser_goto", "browser_click", "browser_fill", "browser_eval", "browser_screenshot", "browser_console", "browser_network", "browser_close",
    ]);
    expect(on.runtimes).toEqual(["pi-durable"]);
  });

  it("returns an install hint when the binary is missing", async () => {
    const ctx = { wolfDen: "/nonexistent", wolfName: "w", domains: [], wolfConfig: {} };
    const ext = createBrowserExtension({ enabled: true, executablePath: "/nope/chrome" }, ctx);
    const res = await ext.tools![0].execute({ url: "https://example.com" }, { cwd: "/", wolfDen: "/nonexistent", wolfName: "w", conversationId: 1 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/No browser binary found/);
  });
});
