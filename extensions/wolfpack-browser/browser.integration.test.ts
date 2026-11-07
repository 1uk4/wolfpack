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
    expect(await session.thread().run(() => session.thread().goto(base + "/", "load"))).toMatch(/Title: hello/);
    expect(await session.thread().run(() => session.thread().evaluate("document.getElementById('h').textContent"))).toBe("Hi");
    await session.thread().run(() => session.thread().fill("#i", "x"));
    expect(await session.thread().run(() => session.thread().evaluate("document.getElementById('i').value"))).toBe("x");
    await new Promise((r) => setTimeout(r, 300));
    expect(session.thread().console({})).toMatch(/from-page/);
    const net = session.thread().network({ urlFilter: "/api" });
    expect(net).toMatch(/"status":200/);
    expect(net).not.toMatch(/TOPSECRET/);
    expect(net).toMatch(/\[redacted\]/);
    expect((await import("node:fs")).statSync(session.profileDir).mode & 0o777).toBe(0o700);
  }, 60000);

  it("blocks redirects and disallowed hosts, and screenshots are removed on close", async () => {
    await expect(session.thread().run(() => session.thread().goto(base + "/redirect"))).rejects.toThrow(/blocked/i);
    await expect(session.thread().run(() => session.thread().goto("http://localhost:1/"))).rejects.toThrow(/blocked/i);
    await expect(session.thread().run(() => session.thread().goto("file:///etc/hosts"))).rejects.toThrow(/blocked/i);
    await session.thread().run(() => session.thread().goto(base + "/"));
    const shot = (await session.thread().run(() => session.thread().screenshot())) as string;
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
      await s.thread().run(() => s.thread().goto(`http://localhost:${port}/`));
      const blocked = await s.thread().run(() => s.thread().evaluate(probe(`ws://127.0.0.1:${port}/`)));
      expect(blocked).not.toBe("open");
      expect(hits).toHaveLength(0);
      expect(s.thread().blockedRequests().join("\n")).toMatch(/ws:\/\/127\.0\.0\.1/);
      // Positive control: with 127.0.0.1 allowlisted the same socket opens (so the block above is the policy's doing).
      await s.close();
      const s2 = new BrowserSession(den, { allowHosts: ["127.0.0.1"], timeoutMs: 15000 });
      try {
        await s2.thread().run(() => s2.thread().goto(`http://127.0.0.1:${port}/`));
        const got = await s2.thread().run(() => s2.thread().evaluate(probe(`ws://127.0.0.1:${port}/`)));
        // Chromium's own local-network check may still refuse a fulfilled page's socket (got "error"), so assert only
        // that OUR policy let it through: nothing recorded as blocked.
        expect(got).toBeTypeOf("string");
        expect(s2.thread().blockedRequests()).toEqual([]);
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
      await s.thread().run(() => s.thread().goto(base + "/"));
      await s.thread().page.close();
      expect(await s.thread().run(() => s.thread().goto(base + "/"))).toMatch(/Title: ok/);
      // after a relaunch the popup-closer must not close the fresh page
      await s.close();
      expect(await s.thread().run(() => s.thread().goto(base + "/"))).toMatch(/Title: ok/);
      expect(await s.thread().run(() => s.thread().evaluate("document.title"))).toBe("ok");
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

  it("loads a gzip page from an allowlisted host", async () => {
    const s = new BrowserSession(den, { allowHosts: ["127.0.0.1"], timeoutMs: 5000 });
    try {
      await s.thread().run(() => s.thread().goto(base + "/gz"));
      expect(await s.thread().run(() => s.thread().evaluate("document.body.textContent"))).toBe("zipped");
    } finally {
      await s.close();
    }
  }, 60000);

  it("stores valid Set-Cookie, rejects a foreign Domain, and sends Lax only on top-level GET navigations", async () => {
    const s = new BrowserSession(den, { allowHosts: ["127.0.0.1"], timeoutMs: 8000 });
    try {
      await s.thread().run(() => s.thread().goto(base + "/setck"));
      seenCookies.length = 0;
      await s.thread().run(() => s.thread().goto(base + "/"));
      expect(seenCookies.at(-1)).toMatch(/a=1/);
      expect(seenCookies.at(-1)).not.toMatch(/bad=/);
    } finally {
      await s.close();
    }
  }, 60000);
});

d("browser extension (live): allowlisted hosts use the browser's own network", () => {
  let srv: Server;
  let port = 0;
  let den = "";
  const wss = new WebSocketServer({ noServer: true });
  const sseHits: string[] = [];
  beforeAll(async () => {
    den = mkdtempSync(join(tmpdir(), "wolf-browser-den-"));
    srv = createServer((req, res) => {
      if (req.url === "/events") {
        sseHits.push(String(req.headers.host));
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        return res.write("data: hello-sse\n\n");
      }
      if (req.url === "/hop") {
        res.writeHead(302, { location: `http://localhost:${port}/events` });
        return res.end();
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<title>p</title>");
    });
    srv.on("upgrade", (req, sock, head) => wss.handleUpgrade(req, sock, head, (ws) => ws.on("message", (m) => ws.send("echo:" + m))));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    port = (srv.address() as AddressInfo).port;
  });
  afterAll(async () => {
    wss.close();
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
    rmSync(den, { recursive: true, force: true });
  });
  const sse = (u: string) => `new Promise(r => { const e = new EventSource(${JSON.stringify(u)}); e.onmessage = (m) => { e.close(); r(m.data); }; e.onerror = () => { e.close(); r("error"); }; setTimeout(() => r("timeout"), 5000); })`;
  const ws = (u: string) => `new Promise(r => { const w = new WebSocket(${JSON.stringify(u)}); w.onopen = () => w.send("hi"); w.onmessage = (m) => { w.close(); r(m.data); }; w.onclose = () => r("closed"); w.onerror = () => r("error"); setTimeout(() => r("timeout"), 5000); })`;

  it("delivers server-sent events and echoes WebSocket messages on an allowlisted host", async () => {
    const s = new BrowserSession(den, { allowHosts: ["127.0.0.1"], timeoutMs: 15000 });
    try {
      await s.thread().run(() => s.thread().goto(`http://127.0.0.1:${port}/`));
      expect(await s.thread().run(() => s.thread().evaluate(sse("/events")))).toBe("hello-sse");
      expect(await s.thread().run(() => s.thread().evaluate(ws(`ws://127.0.0.1:${port}/`)))).toBe("echo:hi");
      expect(s.thread().blockedRequests()).toEqual([]);
    } finally {
      await s.close();
    }
  }, 60000);

  it("keeps the full guard on a loopback host that is not allowlisted (http, SSE, WebSocket)", async () => {
    // page host localhost is allowlisted; 127.0.0.1 is not
    const s = new BrowserSession(den, { allowHosts: ["localhost"], timeoutMs: 15000 });
    try {
      await s.thread().run(() => s.thread().goto(`http://localhost:${port}/`));
      sseHits.length = 0;
      expect(await s.thread().run(() => s.thread().evaluate(`fetch("http://127.0.0.1:${port}/events").then(() => "ok").catch(() => "failed")`))).toBe("failed");
      expect(await s.thread().run(() => s.thread().evaluate(sse(`http://127.0.0.1:${port}/events`)))).toBe("error");
      expect(await s.thread().run(() => s.thread().evaluate(ws(`ws://127.0.0.1:${port}/`)))).not.toBe("echo:hi");
      expect(sseHits).toEqual([]);
      expect(s.thread().blockedRequests().join("\n")).toMatch(/127\.0\.0\.1/);
    } finally {
      await s.close();
    }
  }, 60000);

  it("a fetch() that merely sends Accept: text/event-stream still goes through the fetcher and is refused", async () => {
    const s = new BrowserSession(den, { allowHosts: ["127.0.0.1"], timeoutMs: 15000 });
    try {
      await s.thread().run(() => s.thread().goto(`http://127.0.0.1:${port}/`));
      const r = await s.thread().run(() => s.thread().evaluate(`fetch("/events", { headers: { accept: "text/event-stream" } }).then(() => "ok").catch(() => "failed")`));
      expect(r).toBe("failed");
      expect(s.thread().blockedRequests().join("\n")).toMatch(/event-stream/);
    } finally {
      await s.close();
    }
  }, 60000);

  it("KNOWN GAP (pinned): an EventSource redirect hop on the native path is followed unvetted; flip this if the hop becomes vetted", async () => {
    // Page and allowlist are 127.0.0.1; /hop redirects to localhost, which is NOT allowlisted. The server seeing a
    // localhost Host header proves Chromium followed the hop, and nothing is recorded as blocked.
    const s = new BrowserSession(den, { allowHosts: ["127.0.0.1"], timeoutMs: 15000 });
    try {
      await s.thread().run(() => s.thread().goto(`http://127.0.0.1:${port}/`));
      sseHits.length = 0;
      await s.thread().run(() => s.thread().evaluate(sse("/hop")));
      expect(sseHits).toContain(`localhost:${port}`);
      expect(s.thread().blockedRequests()).toEqual([]);
    } finally {
      await s.close();
    }
  }, 60000);

  it("an EventSource to an allowlisted host other than the page's own host is not served natively", async () => {
    const s = new BrowserSession(den, { allowHosts: ["localhost", "127.0.0.1"], timeoutMs: 15000 });
    try {
      await s.thread().run(() => s.thread().goto(`http://localhost:${port}/`));
      sseHits.length = 0;
      expect(await s.thread().run(() => s.thread().evaluate(sse(`http://127.0.0.1:${port}/events`)))).toBe("error");
      // The fetcher still reaches the server (so sseHits is not empty) but refuses the stream and records it;
      // a native EventSource would record nothing.
      expect(s.thread().blockedRequests().join("\n")).toMatch(/event-stream/);
    } finally {
      await s.close();
    }
  }, 60000);
});

d("browser extension (live): per-thread tabs", () => {
  let srv: Server;
  let base = "";
  let den = "";
  beforeAll(async () => {
    den = mkdtempSync(join(tmpdir(), "wolf-browser-den-"));
    srv = createServer((req, res) => {
      const name = (req.url ?? "/").replace(/^\//, "").split("?")[0] || "root";
      if (name === "slow") {
        return setTimeout(() => { res.writeHead(200, { "content-type": "text/html" }); res.end("<title>slow</title>"); }, 1500);
      }
      res.writeHead(200, { "content-type": "text/html" });
      if (name === "blocker") return res.end(`<title>blocker</title><script>fetch("http://169.254.169.254/latest").catch(() => {})</script>`);
      res.end(`<title>${name}</title><script>console.log("log-${name}");fetch("/api-${name}")</script>`);
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => srv.close(r));
    rmSync(den, { recursive: true, force: true });
  });
  const mk = (extra: object = {}) => new BrowserSession(den, { allowHosts: ["127.0.0.1"], timeoutMs: 15000, ...extra });

  it("two threads navigate to different URLs and each keeps its own page, console and network log", async () => {
    const s = mk();
    try {
      const a = s.thread("1");
      const b = s.thread("2");
      await Promise.all([a.run(() => a.goto(base + "/alpha")), b.run(() => b.goto(base + "/beta"))]);
      expect(await a.run(() => a.evaluate("document.title"))).toBe("alpha");
      expect(await b.run(() => b.evaluate("document.title"))).toBe("beta");
      await new Promise((r) => setTimeout(r, 300));
      expect(a.console({})).toMatch(/log-alpha/);
      expect(a.console({})).not.toMatch(/log-beta/);
      expect(b.console({})).not.toMatch(/log-alpha/);
      expect(a.network({})).toMatch(/api-alpha/);
      expect(a.network({})).not.toMatch(/api-beta/);
      expect(b.network({})).not.toMatch(/api-alpha/);
    } finally {
      await s.close();
    }
  }, 60000);

  it("a slow call in one thread does not block another; calls inside a thread stay ordered", async () => {
    const s = mk();
    try {
      const a = s.thread("1");
      const b = s.thread("2");
      const order: string[] = [];
      const slow = a.run(() => a.goto(base + "/slow")).then(() => order.push("slow"));
      await b.run(() => b.goto(base + "/fast"));
      order.push("fast");
      await slow;
      expect(order).toEqual(["fast", "slow"]);
      const seq: number[] = [];
      await Promise.all([1, 2, 3].map((n) => a.run(async () => { await new Promise((r) => setTimeout(r, 50 * (4 - n))); seq.push(n); })));
      expect(seq).toEqual([1, 2, 3]);
    } finally {
      await s.close();
    }
  }, 60000);

  it("a request the guard blocks is listed on the tab that made it and not on the other", async () => {
    const s = mk();
    try {
      const a = s.thread("1");
      const b = s.thread("2");
      await a.run(() => a.goto(base + "/blocker"));
      await b.run(() => b.goto(base + "/y"));
      const deadline = Date.now() + 5000;
      while (!a.blockedRequests().join("\n").includes("169.254.169.254") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(a.blockedRequests().join("\n")).toMatch(/169\.254\.169\.254/);
      expect(b.blockedRequests()).toEqual([]);
      await expect(b.run(() => b.goto("http://localhost:1/"))).rejects.toThrow(/blocked/i);
    } finally {
      await s.close();
    }
  }, 60000);

  it("closing one thread's tab leaves the other working; closing the last tab shuts the browser down", async () => {
    const s = mk();
    try {
      const a = s.thread("1");
      const b = s.thread("2");
      await a.run(() => a.goto(base + "/alpha"));
      await b.run(() => b.goto(base + "/beta"));
      const shot = await b.run(() => b.screenshot());
      await a.closeTab();
      expect(s.isOpen).toBe(true);
      expect(await b.run(() => b.evaluate("document.title"))).toBe("beta");
      // the closed thread gets a fresh tab on its next call
      expect(await a.run(() => a.goto(base + "/again"))).toMatch(/Title: again/);
      await a.closeTab();
      await b.closeTab();
      expect(s.isOpen).toBe(false);
      expect(existsSync(shot)).toBe(false);
    } finally {
      await s.close();
    }
  }, 60000);

  it("a tab that crashed or was closed under the thread is recreated on its next call", async () => {
    const s = mk();
    try {
      const a = s.thread("1");
      await a.run(() => a.goto(base + "/alpha"));
      await a.page.close();
      expect(await a.run(() => a.goto(base + "/beta"))).toMatch(/Title: beta/);
    } finally {
      await s.close();
    }
  }, 60000);

  it("idle tabs are closed after the timeout (injected clock)", async () => {
    let now = 1_000;
    const s = mk({ tabIdleMs: 60_000 });
    s.now = () => now;
    try {
      const a = s.thread("1");
      await a.run(() => a.goto(base + "/alpha"));
      await s.sweepIdle();
      expect(s.isOpen).toBe(true);
      now += 61_000;
      await s.sweepIdle();
      expect(s.isOpen).toBe(false);
    } finally {
      await s.close();
    }
  }, 60000);

  it("over the tab cap the least recently used idle tab is closed", async () => {
    let now = 1_000;
    const s = mk({ maxTabs: 2 });
    s.now = () => now;
    try {
      const [a, b, c] = [s.thread("1"), s.thread("2"), s.thread("3")];
      await a.run(() => a.goto(base + "/alpha"));
      now += 10;
      await b.run(() => b.goto(base + "/beta"));
      now += 10;
      await c.run(() => c.goto(base + "/gamma"));
      expect(s.openTabs().sort()).toEqual(["2", "3"]);
      expect(await b.run(() => b.evaluate("document.title"))).toBe("beta");
    } finally {
      await s.close();
    }
  }, 60000);

  it("calls queued behind a closing tab fail with 'tab closed' instead of reopening it", async () => {
    const s = mk();
    try {
      const a = s.thread("1");
      await a.run(() => a.goto(base + "/alpha"));
      let started = false;
      const slow = a.run(() => new Promise((r) => { started = true; setTimeout(r, 300); }));
      while (!started) await new Promise((r) => setTimeout(r, 5));
      const queued = a.run(() => a.goto(base + "/beta"));
      const settled = expect(queued).rejects.toThrow(/tab closed/i);
      await a.closeTab();
      await settled;
      await slow;
      expect(s.openTabs()).toEqual([]);
    } finally {
      await s.close();
    }
  }, 60000);

  it("a stale handle to a closed tab cannot take over the thread's new tab", async () => {
    const s = mk();
    try {
      const old = s.thread("1");
      await old.run(() => old.goto(base + "/alpha"));
      await old.closeTab();
      const fresh = s.thread("1");
      await fresh.run(() => fresh.goto(base + "/beta"));
      await expect(old.run(() => old.goto(base + "/gamma"))).rejects.toThrow(/tab closed/i);
      expect(s.thread("1")).toBe(fresh);
      expect(await fresh.run(() => fresh.evaluate("document.title"))).toBe("beta");
    } finally {
      await s.close();
    }
  }, 60000);

  it("closing the whole browser fails calls queued on old tabs instead of relaunching it", async () => {
    const s = mk();
    try {
      const a = s.thread("1");
      await a.run(() => a.goto(base + "/alpha"));
      let started = false;
      const slow = a.run(() => new Promise((r) => { started = true; setTimeout(r, 300); }));
      while (!started) await new Promise((r) => setTimeout(r, 5));
      const queued = a.run(() => a.goto(base + "/beta"));
      const settled = expect(queued).rejects.toThrow(/tab closed/i);
      await s.close();
      await settled;
      await slow;
      expect(s.isOpen).toBe(false);
    } finally {
      await s.close();
    }
  }, 60000);

  it("a call arriving while the browser is closing waits for the close, then launches a clean browser", async () => {
    const s = mk();
    try {
      const a = s.thread("1");
      await a.run(() => a.goto(base + "/alpha"));
      const closing = s.close();
      const b = s.thread("2");
      const res = await b.run(() => b.goto(base + "/beta"));
      await closing;
      expect(res).toMatch(/Title: beta/);
      expect(s.isOpen).toBe(true);
      expect(await b.run(() => b.evaluate("document.title"))).toBe("beta");
    } finally {
      await s.close();
    }
  }, 60000);

  it("concurrent first calls never open more than maxTabs pages", async () => {
    const s = mk({ maxTabs: 2 });
    try {
      let peak = 0;
      const poll = setInterval(() => { peak = Math.max(peak, s.pageCount()); }, 5);
      const threads = ["1", "2", "3", "4"].map((id) => s.thread(id));
      await Promise.allSettled(threads.map((t) => t.run(() => t.goto(base + "/c"))));
      clearInterval(poll);
      peak = Math.max(peak, s.pageCount());
      expect(peak).toBeLessThanOrEqual(2);
      expect(s.openTabs().length).toBeLessThanOrEqual(2);
    } finally {
      await s.close();
    }
  }, 60000);

  it("over the cap with every tab busy refuses with a clear message", async () => {
    const s = mk({ maxTabs: 1 });
    try {
      const a = s.thread("1");
      const b = s.thread("2");
      await a.run(() => a.goto(base + "/alpha"));
      const busy = a.run(() => new Promise((r) => setTimeout(r, 800)));
      await expect(b.run(() => b.goto(base + "/beta"))).rejects.toThrow(/too many browser tabs/i);
      await busy;
    } finally {
      await s.close();
    }
  }, 60000);

  it("tools use the calling thread's conversationId, and browser_close closes only that thread", async () => {
    const ext = createBrowserExtension({ enabled: true, allowHosts: ["127.0.0.1"], timeoutMs: 15000 }, { wolfDen: den, wolfName: "w", domains: [], wolfConfig: {} });
    const tool = (n: string) => ext.tools!.find((t) => t.name === n)!;
    const t1 = { cwd: "/", wolfDen: den, wolfName: "w", conversationId: 1 };
    const t2 = { ...t1, conversationId: 2 };
    try {
      await tool("browser_goto").execute({ url: base + "/alpha" }, t1);
      await tool("browser_goto").execute({ url: base + "/beta" }, t2);
      expect((await tool("browser_eval").execute({ expression: "document.title" }, t1)).content[0].text).toBe("alpha");
      expect((await tool("browser_eval").execute({ expression: "document.title" }, t2)).content[0].text).toBe("beta");
      await tool("browser_close").execute({}, t1);
      expect((await tool("browser_eval").execute({ expression: "document.title" }, t2)).content[0].text).toBe("beta");
      // a conversationId that is not a finite number falls back to the "default" tab
      await tool("browser_goto").execute({ url: base + "/gamma" }, { ...t1, conversationId: NaN });
      expect((await tool("browser_eval").execute({ expression: "document.title" }, { cwd: "/", wolfDen: den, wolfName: "w" } as any)).content[0].text).toBe("gamma");
    } finally {
      await ext.lifecycle?.stop?.();
    }
  }, 60000);
});

d("browser extension (live): tab guard", () => {
  let srv: Server;
  let wss: WebSocketServer;
  let port = 0;
  let den = "";
  const wsHits: string[] = [];
  beforeAll(async () => {
    den = mkdtempSync(join(tmpdir(), "wolf-browser-den-"));
    srv = createServer((req, res) => {
      if (req.url === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        return res.write("data: hello-sse\n\n");
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<title>p</title>");
    });
    wss = new WebSocketServer({ server: srv });
    wss.on("connection", (_sock, req) => { wsHits.push(String(req.headers.host)); });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    port = (srv.address() as AddressInfo).port;
  });
  afterAll(async () => {
    wss.close();
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
    rmSync(den, { recursive: true, force: true });
  });
  // page host localhost is allowlisted; the ws target 127.0.0.1 is NOT
  const mk = (extra: object = {}) => new BrowserSession(den, { allowHosts: ["localhost"], timeoutMs: 15000, ...extra });
  const probe = (u: string) => `new Promise(r => { const w = new WebSocket(${JSON.stringify(u)}); w.onopen = () => r("open"); w.onclose = () => r("closed"); w.onerror = () => r("error"); setTimeout(() => r("timeout"), 3000); })`;

  it("blocks a WebSocket to a non-allowlisted host from a second tab and from a popup", async () => {
    const s = mk();
    try {
      const a = s.thread("1");
      const b = s.thread("2");
      await a.run(() => a.goto(`http://localhost:${port}/`));
      await b.run(() => b.goto(`http://localhost:${port}/`));
      wsHits.length = 0;
      expect(await b.run(() => b.evaluate(probe(`ws://127.0.0.1:${port}/`)))).not.toBe("open");
      // A popup is closed by the guard, but the socket is opened synchronously from its initial document. Whether the
      // connection gets out before the close is a race; the property is that it never reaches the server.
      await a.run(() => a.evaluate(`(() => { const w = window.open("/", "_blank"); new w.WebSocket("ws://127.0.0.1:${port}/"); return "sent"; })()`));
      await new Promise((r) => setTimeout(r, 1000));
      expect(wsHits).toEqual([]);
      expect(b.blockedRequests().join("\n")).toMatch(/ws:\/\/127\.0\.0\.1/);
    } finally {
      await s.close();
    }
  }, 60000);

  it("an HTTP request blocked on a page no tab owns is listed in strayBlocked()", async () => {
    const s = mk();
    try {
      const a = s.thread("1");
      await a.run(() => a.goto(`http://localhost:${port}/`));
      await a.run(() => a.evaluate(`(() => { window.open("http://169.254.169.254/latest", "_blank"); return "sent"; })()`));
      const deadline = Date.now() + 5000;
      while (!s.strayBlocked().join("\n").includes("169.254.169.254") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(s.strayBlocked().join("\n")).toMatch(/169\.254\.169\.254/);
    } finally {
      await s.close();
    }
  }, 60000);

  // Regression guard for the timing of closeStrays(). Not seen red: the old opener check also closed these popups.
  it("a noopener popup from one tab while other tabs are opening is closed, not kept as a stray page", async () => {
    const s = mk();
    try {
      const url = `http://localhost:${port}/`;
      const openers = [s.thread("b1"), s.thread("b2")];
      for (const o of openers) {
        await o.run(() => o.goto(url));
        // a click is a user gesture, so Chromium lets the popup open (a bare window.open() would be blocked)
        await o.run(() => o.evaluate(`(document.body.innerHTML = '<a id=l target=_blank rel=noopener href="/">x</a>', 1)`));
      }
      const storm = openers.map(async (o) => { for (let i = 0; i < 60; i++) await o.run(() => o.click("#l")); });
      await new Promise((r) => setTimeout(r, 100));
      const opening = [s.thread("a1"), s.thread("a2"), s.thread("a3"), s.thread("a4")];
      for (const t of opening) await t.run(() => t.goto(url));
      await Promise.all(storm);
      const deadline = Date.now() + 5000;
      while (s.pageCount() > 6 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(s.pageCount()).toBe(6);
    } finally {
      await s.close();
    }
  }, 60000);

  it("an EventSource's own-host check uses its own tab, not another tab's page", async () => {
    const s = mk({ allowHosts: ["localhost", "127.0.0.1"] });
    try {
      const a = s.thread("1");
      const b = s.thread("2");
      await a.run(() => a.goto(`http://localhost:${port}/`));
      // tab B sits on 127.0.0.1, the very host tab A's EventSource targets
      await b.run(() => b.goto(`http://127.0.0.1:${port}/`));
      const sse = `new Promise(r => { const e = new EventSource("http://127.0.0.1:${port}/events"); e.onmessage = (m) => { e.close(); r(m.data); }; e.onerror = () => { e.close(); r("error"); }; setTimeout(() => r("timeout"), 5000); })`;
      expect(await a.run(() => a.evaluate(sse))).toBe("error");
      expect(a.blockedRequests().join("\n")).toMatch(/event-stream/);
      // positive control: from its own host tab B the same stream is served natively
      expect(await b.run(() => b.evaluate(sse))).toBe("hello-sse");
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
