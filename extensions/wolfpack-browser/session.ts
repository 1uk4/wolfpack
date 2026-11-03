/**
 * One lazily launched, guarded Chromium for a wolf. All calls run through a single queue on a single page.
 * Playwright is imported lazily so a wolf that never uses the browser (or a host without the binary) loads fine.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, chmodSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { guardedFetch } from "./fetcher.js";
import { capText, checkUrlResolved, guardedLookup, lastN, redactHeaders, redactUrl, type Resolver } from "./policy.js";

export interface BrowserConfig {
  /** Master switch. Default false: no tools are registered. */
  enabled?: boolean;
  /** Show the window instead of running headless. Default false. */
  headed?: boolean;
  /** Explicit browser binary; else Playwright's cache, then system Google Chrome. */
  executablePath?: string;
  /** Hosts reachable even though they are loopback/private/tailnet. Exact host/IP or `*.suffix`. */
  allowHosts?: string[];
  /** Default navigation timeout, ms. Default 30000. */
  timeoutMs?: number;
  /** Cap on characters returned by eval / console / network. Default 20000. */
  maxOutputChars?: number;
  /** Largest response body the browser may receive, bytes. Default 25 MB. */
  maxResponseBytes?: number;
}

export const DEFAULTS = { timeoutMs: 30_000, maxOutputChars: 20_000, maxResponseBytes: 25 * 1024 * 1024, logCap: 500 };

export const INSTALL_HINT =
  "No browser binary found. Install one without touching your own profile: `npx playwright-core install chromium` " +
  "(or `npx playwright install chromium`), install Google Chrome, or set `browser.executablePath` in wolf.yaml.";

export interface Found {
  executablePath?: string;
  channel?: string;
}

/** Locate an already-installed browser. Never downloads. */
export function findBrowser(cfg: BrowserConfig, headless: boolean, env: NodeJS.ProcessEnv = process.env): Found | undefined {
  if (cfg.executablePath) return existsSync(cfg.executablePath) ? { executablePath: cfg.executablePath } : undefined;
  const roots = [
    env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== "0" ? env.PLAYWRIGHT_BROWSERS_PATH : "",
    join(homedir(), "Library", "Caches", "ms-playwright"),
    join(homedir(), ".cache", "ms-playwright"),
  ].filter(Boolean);
  for (const root of roots) {
    let names: string[] = [];
    try {
      names = readdirSync(root).sort().reverse();
    } catch {
      continue;
    }
    const candidates: string[] = [];
    for (const n of names) {
      if (headless && n.startsWith("chromium_headless_shell-")) {
        for (const sub of readdirSync(join(root, n)).filter((s) => s.startsWith("chrome-headless-shell"))) {
          candidates.push(join(root, n, sub, "chrome-headless-shell"));
        }
      }
      if (n.startsWith("chromium-")) {
        for (const sub of readdirSync(join(root, n)).filter((s) => s.startsWith("chrome-"))) {
          candidates.push(
            join(root, n, sub, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
            join(root, n, sub, "Chromium.app", "Contents", "MacOS", "Chromium"),
            join(root, n, sub, "chrome"),
          );
        }
        candidates.push(join(root, n, "chrome-linux", "chrome"));
      }
    }
    const hit = candidates.find((c) => existsSync(c));
    if (hit) return { executablePath: hit };
  }
  if (existsSync("/Applications/Google Chrome.app")) return { channel: "chrome" };
  for (const p of ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
    if (existsSync(p)) return { executablePath: p };
  }
  return undefined;
}

interface ConsoleEntry { t: string; type: string; text: string }
interface NetEntry {
  method: string;
  url: string;
  status?: number;
  failure?: string;
  requestHeaders: Record<string, string>;
  responseHeaders?: Record<string, string>;
}

export class BrowserSession {
  private ctx: any;
  private page: any;
  private launching?: Promise<void>;
  private chain: Promise<unknown> = Promise.resolve();
  private shotDir?: string;
  private shots = 0;
  private consoleLog: ConsoleEntry[] = [];
  private netLog: NetEntry[] = [];
  private blocked: string[] = [];
  private readonly resolver?: Resolver;

  constructor(
    private readonly den: string,
    private readonly cfg: BrowserConfig,
    opts: { resolver?: Resolver } = {},
  ) {
    this.resolver = opts.resolver;
  }

  private get max(): number { return this.cfg.maxOutputChars ?? DEFAULTS.maxOutputChars; }
  private get timeout(): number { return this.cfg.timeoutMs ?? DEFAULTS.timeoutMs; }
  get profileDir(): string { return join(this.den, "state", "browser-profile"); }
  get isOpen(): boolean { return !!this.ctx; }

  /** Serialise `fn` after every earlier call; a failure does not poison the queue. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async verdict(url: string, navigation: boolean) {
    return checkUrlResolved(url, { allowHosts: this.cfg.allowHosts, navigation }, this.resolver);
  }

  private async launch(): Promise<void> {
    if (this.page) return;
    this.launching ??= this.doLaunch().finally(() => { this.launching = undefined; });
    await this.launching;
  }

  private ensureShotDir(): string {
    if (!this.shotDir || !existsSync(this.shotDir)) {
      sweepStaleShotDirs();
      this.shotDir = mkdtempSync(join(tmpdir(), `wolf-browser-${process.pid}-`));
    }
    return this.shotDir;
  }

  private removeShotDir() {
    if (this.shotDir) rmSync(this.shotDir, { recursive: true, force: true });
    this.shotDir = undefined;
  }

  private blockRecord(url: string, why: string | undefined) {
    this.blocked.push(`${redactUrl(url)}: ${why}`);
    if (this.blocked.length > 50) this.blocked.shift();
  }

  private async doLaunch(): Promise<void> {
    if (!this.ctx) await this.launchContext();
    if (!this.page) await this.openPage();
  }

  private async launchContext(): Promise<void> {
    const headless = !this.cfg.headed;
    const found = findBrowser(this.cfg, headless);
    if (!found) throw new Error(INSTALL_HINT);
    const { chromium } = await import("playwright-core");
    mkdirSync(join(this.den, "state"), { recursive: true });
    mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
    chmodSync(this.profileDir, 0o700);
    this.ensureShotDir();
    let ctx: any;
    try {
      ctx = await chromium.launchPersistentContext(this.profileDir, {
        headless,
        ...(found.executablePath ? { executablePath: found.executablePath } : {}),
        ...(found.channel ? { channel: found.channel } : {}),
        viewport: { width: 1280, height: 800 },
        acceptDownloads: false,
        serviceWorkers: "block",
        args: [
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-extensions",
          // WebRTC would otherwise reach hosts (and leak LAN addresses) outside the request policy.
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
          "--webrtc-ip-handling-policy=disable_non_proxied_udp",
        ],
      });
    } catch (err) {
      this.removeShotDir();
      throw new Error(`Browser failed to launch: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}. ${INSTALL_HINT}`);
    }
    this.ctx = ctx;
    ctx.on("close", () => {
      if (this.ctx === ctx) { this.ctx = undefined; this.page = undefined; }
      this.removeShotDir();
    });
    const allowHosts = this.cfg.allowHosts;
    const lookup = guardedLookup(allowHosts, this.resolver);
    // Every HTTP(S) request the page makes is performed in Node over a connect-time-vetted lookup (see fetcher.ts).
    await ctx.route(/.*/, async (route: any) => {
      const req = route.request();
      const url: string = req.url();
      const v = await this.verdict(url, req.isNavigationRequest());
      if (!v.ok) {
        this.blockRecord(url, v.reason);
        return route.abort("blockedbyclient").catch(() => undefined);
      }
      if (!/^https?:/i.test(url)) return route.continue().catch(() => undefined);
      try {
        const headers: Record<string, string> = {};
        for (const [k, val] of Object.entries(await req.allHeaders() as Record<string, string>)) {
          if (!["host", "content-length", "connection", "accept-encoding", "cookie", "transfer-encoding"].includes(k.toLowerCase())) headers[k] = val;
        }
        headers["accept-encoding"] = "identity";
        const jar: { name: string; value: string }[] = await ctx.cookies(url);
        if (jar.length) headers["cookie"] = jar.map((c) => `${c.name}=${c.value}`).join("; ");
        const res = await guardedFetch({
          url,
          method: req.method(),
          headers,
          body: req.postDataBuffer(),
          lookup,
          maxBytes: this.cfg.maxResponseBytes ?? DEFAULTS.maxResponseBytes,
          timeoutMs: this.timeout,
        });
        const loc = res.headers["location"];
        if (res.status >= 300 && res.status < 400 && typeof loc === "string") {
          const target = new URL(loc, url).toString();
          const rv = await this.verdict(target, req.isNavigationRequest());
          if (!rv.ok) {
            this.blockRecord(url, `redirect to ${redactUrl(target)}: ${rv.reason}`);
            return route.abort("blockedbyclient").catch(() => undefined);
          }
        }
        const setCookies = res.headers["set-cookie"];
        if (setCookies) await storeCookies(ctx, url, Array.isArray(setCookies) ? setCookies : [setCookies]);
        const out: Record<string, string> = {};
        for (const [k, val] of Object.entries(res.headers)) {
          if (["set-cookie", "content-encoding", "transfer-encoding", "connection", "content-length"].includes(k)) continue;
          out[k] = Array.isArray(val) ? val.join(", ") : String(val);
        }
        return route.fulfill({ status: res.status, headers: out, body: res.body }).catch(() => undefined);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith("blocked:")) this.blockRecord(url, msg.slice(8).trim());
        return route.abort(msg.startsWith("blocked:") ? "blockedbyclient" : "failed").catch(() => undefined);
      }
    });
    // WebSockets bypass context.route: same policy, applied before the page may talk to the server.
    await ctx.routeWebSocket(/.*/, async (ws: any) => {
      const url: string = ws.url();
      const v = await checkUrlResolved(url, { allowHosts, websocket: true }, this.resolver);
      if (!v.ok) {
        this.blockRecord(url, v.reason);
        await ws.close({ code: 1008, reason: "blocked by browser policy" }).catch(() => undefined);
        return;
      }
      ws.connectToServer();
    });
  }

  /** Open the single working page; pages restored from the profile and later popups are closed. */
  private async openPage(): Promise<void> {
    const ctx = this.ctx;
    const page = await ctx.newPage();
    this.page = page;
    for (const old of ctx.pages()) if (old !== page) await old.close().catch(() => undefined);
    ctx.on("page", (p: any) => { if (p !== this.page) p.close().catch(() => undefined); });
    page.setDefaultTimeout(this.timeout);
    page.on("close", () => { if (this.page === page) this.page = undefined; });
    page.on("console", (m: any) => this.push(this.consoleLog, { t: new Date().toISOString(), type: m.type(), text: redactText(m.text()) }));
    page.on("pageerror", (e: Error) => this.push(this.consoleLog, { t: new Date().toISOString(), type: "pageerror", text: redactText(String(e.message)) }));
    const byReq = new WeakMap<object, NetEntry>();
    page.on("request", (r: any) => {
      const e: NetEntry = { method: r.method(), url: redactUrl(r.url()), requestHeaders: redactHeaders(r.headers()) };
      byReq.set(r, e);
      this.push(this.netLog, e);
    });
    page.on("response", (r: any) => {
      const e = byReq.get(r.request());
      if (e) { e.status = r.status(); e.responseHeaders = redactHeaders(r.headers()); }
    });
    page.on("requestfailed", (r: any) => {
      const e = byReq.get(r);
      if (e) e.failure = r.failure()?.errorText ?? "failed";
    });
  }

  private push<T>(arr: T[], item: T) {
    arr.push(item);
    if (arr.length > DEFAULTS.logCap) arr.shift();
  }

  private async ready() {
    await this.launch();
    return this.page;
  }

  async goto(url: string, waitUntil: "load" | "domcontentloaded" | "networkidle" | "commit" = "load", timeoutMs?: number): Promise<string> {
    const v = await this.verdict(url, true);
    if (!v.ok) throw new Error(`Navigation blocked: ${v.reason}`);
    const page = await this.ready();
    const before = this.blocked.length;
    let status: number | undefined;
    try {
      const go = () => page.goto(url, { waitUntil, timeout: timeoutMs ?? this.timeout });
      // A reset to about:blank after an earlier blocked navigation can still be settling: retry once.
      const res = await go().catch(async (e: Error) => {
        if (!/interrupted by another navigation/.test(e.message) || this.blocked.length > before) throw e;
        await new Promise((r) => setTimeout(r, 250));
        return go();
      });
      status = res?.status();
    } catch (err) {
      const newly = this.blocked.slice(before);
      if (newly.length) {
        // Leave the error page behind so it cannot interrupt the next navigation.
        await new Promise((r) => setTimeout(r, 150));
        await page.goto("about:blank").catch(() => undefined);
        throw new Error(`Navigation blocked: ${newly.join("; ")}`);
      }
      throw err;
    }
    // Belt and braces: whatever we ended on (redirects, JS) must pass too.
    const final = page.url();
    const fv = await this.verdict(final, true);
    if (!fv.ok) {
      await page.goto("about:blank").catch(() => undefined);
      throw new Error(`Navigation ended on a blocked URL (${fv.reason}); page reset`);
    }
    return `Loaded ${redactUrl(final)}${status ? ` (HTTP ${status})` : ""}\nTitle: ${await page.title()}`;
  }

  async click(selector: string): Promise<string> {
    const page = await this.ready();
    await page.click(selector);
    return `Clicked ${selector}. Now at ${redactUrl(page.url())}`;
  }

  async fill(selector: string, value: string): Promise<string> {
    const page = await this.ready();
    await page.fill(selector, value);
    return `Filled ${selector}`;
  }

  async evaluate(expression: string): Promise<string> {
    const page = await this.ready();
    const result = await page.evaluate(expression);
    let text: string;
    try {
      text = result === undefined ? "undefined" : typeof result === "string" ? result : JSON.stringify(result, null, 2);
    } catch {
      text = String(result);
    }
    return capText(text ?? "undefined", this.max);
  }

  async screenshot(fullPage = false): Promise<string> {
    const page = await this.ready();
    const file = join(this.ensureShotDir(), `shot-${++this.shots}.png`);
    await page.screenshot({ path: file, fullPage });
    return file;
  }

  console(opts: { limit?: number; filter?: string; clear?: boolean }): string {
    const f = opts.filter?.toLowerCase();
    const rows = this.consoleLog.filter((e) => !f || e.text.toLowerCase().includes(f) || e.type.includes(f));
    const out = lastN(rows, opts.limit, 200).map((e) => `${e.t} [${e.type}] ${e.text}`).join("\n");
    if (opts.clear) this.consoleLog = [];
    return capText(out || "(no console messages)", this.max);
  }

  network(opts: { limit?: number; urlFilter?: string; status?: number; clear?: boolean }): string {
    const rows = this.netLog.filter((e) => (!opts.urlFilter || e.url.includes(opts.urlFilter)) && (opts.status === undefined || e.status === opts.status));
    const out = lastN(rows, opts.limit, 200).map((e) => JSON.stringify(e)).join("\n");
    if (opts.clear) this.netLog = [];
    return capText(out || "(no network entries)", this.max);
  }

  blockedRequests(): string[] { return [...this.blocked]; }

  /** Close the browser and delete the session's screenshots. Safe to call repeatedly. */
  async close(): Promise<void> {
    const ctx = this.ctx;
    this.ctx = undefined;
    this.page = undefined;
    this.consoleLog = [];
    this.netLog = [];
    if (ctx) await ctx.close().catch(() => undefined);
    this.removeShotDir();
  }
}

/** Mask URL-ish secrets inside free text (console output may echo URLs with tokens). */
function redactText(t: string): string {
  return t.replace(/https?:\/\/[^\s"'<>)]+/g, (u) => redactUrl(u));
}

/** Remove screenshot dirs left by wolfd processes that no longer exist. */
function sweepStaleShotDirs() {
  let names: string[] = [];
  try { names = readdirSync(tmpdir()); } catch { return; }
  for (const n of names) {
    const m = /^wolf-browser-(\d+)-/.exec(n);
    if (!m || Number(m[1]) === process.pid) continue;
    try { process.kill(Number(m[1]), 0); } catch (e: any) {
      if (e?.code === "ESRCH") rmSync(join(tmpdir(), n), { recursive: true, force: true });
    }
  }
}

/** Minimal Set-Cookie to cookie-jar bridge (the response is fulfilled by us, so the browser never sees the header). */
async function storeCookies(ctx: any, url: string, headers: string[]) {
  for (const h of headers) {
    const [pair, ...attrs] = h.split(";").map((x) => x.trim());
    const eq = pair.indexOf("=");
    if (eq < 1) continue;
    const cookie: Record<string, unknown> = { name: pair.slice(0, eq), value: pair.slice(eq + 1) };
    let domain: string | undefined;
    let path: string | undefined;
    for (const a of attrs) {
      const [k, v = ""] = a.split("=");
      const key = k.toLowerCase();
      if (key === "domain") domain = v.replace(/^\./, "") ? "." + v.replace(/^\./, "") : undefined;
      else if (key === "path") path = v;
      else if (key === "secure") cookie.secure = true;
      else if (key === "httponly") cookie.httpOnly = true;
      else if (key === "max-age" && Number.isFinite(Number(v))) cookie.expires = Math.floor(Date.now() / 1000) + Number(v);
      else if (key === "expires" && cookie.expires === undefined && !Number.isNaN(Date.parse(v))) cookie.expires = Math.floor(Date.parse(v) / 1000);
      else if (key === "samesite" && /^(strict|lax|none)$/i.test(v)) cookie.sameSite = v[0].toUpperCase() + v.slice(1).toLowerCase();
    }
    if (domain || path) Object.assign(cookie, { domain: domain ?? new URL(url).hostname, path: path ?? "/" });
    else cookie.url = url;
    await ctx.addCookies([cookie]).catch(() => undefined);
  }
}
