/**
 * One lazily launched, guarded Chromium for a wolf, with one tab per thread (conversation): each tab has its own queue,
 * page and logs; the browser, profile and cookies are shared.
 * Playwright is imported lazily so a wolf that never uses the browser (or a host without the binary) loads fine.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, chmodSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseSetCookie, selectCookies, fetchSite, worstSite, type FetchSite, type JarCookie } from "./cookies.js";
import { guardedFetch, HOP_BY_HOP } from "./fetcher.js";
import { capText, checkUrlResolved, guardedLookup, hostAllowed, lastN, redactHeaders, redactUrl, type Resolver } from "./policy.js";

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
  /** Most tabs (threads with a live page) at once. Default 6. */
  maxTabs?: number;
  /** Close a thread's tab after this many ms without a call. Default 15 minutes. */
  tabIdleMs?: number;
}

export const DEFAULTS = { timeoutMs: 30_000, maxOutputChars: 20_000, maxResponseBytes: 25 * 1024 * 1024, logCap: 500, maxTabs: 6, tabIdleMs: 15 * 60_000 };

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

export interface ConsoleEntry { t: string; type: string; text: string }
export interface NetEntry {
  method: string;
  url: string;
  status?: number;
  failure?: string;
  requestHeaders: Record<string, string>;
  responseHeaders?: Record<string, string>;
}

export class BrowserSession {
  private ctx: any;
  private ctxLaunching?: Promise<void>;
  /** In-flight close(): a new launch waits for it so two Chromiums never share the profile. */
  private closing?: Promise<void>;
  private readonly tabs = new Map<string, Tab>();
  private readonly byPage = new WeakMap<object, Tab>();
  private shotDir?: string;
  private shots = 0;
  private readonly resolver?: Resolver;
  private sweeper?: NodeJS.Timeout;
  private openChain: Promise<unknown> = Promise.resolve();
  /** Number of tabs currently inside newPage(). */
  private opening = 0;
  private readonly stray: string[] = [];
  /** Injectable clock (ms), for idle and LRU decisions. */
  now: () => number = () => Date.now();

  constructor(
    private readonly den: string,
    private readonly cfg: BrowserConfig,
    opts: { resolver?: Resolver } = {},
  ) {
    this.resolver = opts.resolver;
  }

  get max(): number { return this.cfg.maxOutputChars ?? DEFAULTS.maxOutputChars; }
  get timeout(): number { return this.cfg.timeoutMs ?? DEFAULTS.timeoutMs; }
  private get maxTabs(): number { return Math.max(1, this.cfg.maxTabs ?? DEFAULTS.maxTabs); }
  private get tabIdleMs(): number { return this.cfg.tabIdleMs ?? DEFAULTS.tabIdleMs; }
  get profileDir(): string { return join(this.den, "state", "browser-profile"); }
  get isOpen(): boolean { return !!this.ctx; }

  /** The tab of one thread (conversation), created lazily; its page opens on the first browser call. */
  thread(id: string | number = "default"): Tab {
    const key = String(id);
    let t = this.tabs.get(key);
    if (!t) { t = new Tab(this, key); this.tabs.set(key, t); }
    return t;
  }

  /** Ids of the threads that currently have a live page. */
  openTabs(): string[] { return [...this.tabs.values()].filter((t) => t.page).map((t) => t.id); }

  /** @internal used by Tab */
  async verdict(url: string, navigation: boolean) {
    return checkUrlResolved(url, { allowHosts: this.cfg.allowHosts, navigation }, this.resolver);
  }

  private tabOf(req: any): Tab | undefined {
    try { return this.byPage.get(req.frame().page()); } catch { return undefined; }
  }

  ensureShotDir(): string {
    if (!this.shotDir || !existsSync(this.shotDir)) {
      sweepStaleShotDirs();
      this.shotDir = mkdtempSync(join(tmpdir(), `wolf-browser-${process.pid}-`));
    }
    return this.shotDir;
  }

  nextShot(): number { return ++this.shots; }

  private removeShotDir() {
    if (this.shotDir) rmSync(this.shotDir, { recursive: true, force: true });
    this.shotDir = undefined;
  }

  /** Launch the shared Chromium context once. */
  async ensureContext(): Promise<void> {
    if (this.closing) await this.closing.catch(() => undefined);
    if (this.ctx) return;
    this.ctxLaunching ??= this.launchContext().finally(() => { this.ctxLaunching = undefined; });
    await this.ctxLaunching;
    this.startSweeper();
  }

  /** Make room for one more live page: close the least recently used idle tab, or refuse. */
  makeRoom(except: Tab): Promise<void> {
    const live = [...this.tabs.values()].filter((t) => t.page && t !== except);
    if (live.length < this.maxTabs) return Promise.resolve();
    const idle = live.filter((t) => t.busy === 0).sort((x, y) => x.lastUsed - y.lastUsed)[0];
    if (!idle) {
      return Promise.reject(new Error(`Too many browser tabs open (${live.length}/${this.maxTabs}) and all are busy; retry shortly or call browser_close in an idle thread.`));
    }
    return idle.closeTab({ keepBrowser: true });
  }

  /** Open a page for a tab (shared context). Serialised, so the cap check and the page it admits are one step. */
  newPage(tab: Tab): Promise<any> {
    const next = this.openChain.then(() => this.newPageLocked(tab), () => this.newPageLocked(tab));
    this.openChain = next.catch(() => undefined);
    return next;
  }

  private async newPageLocked(tab: Tab): Promise<any> {
    await this.ensureContext();
    const held = this.tabs.get(tab.id);
    if (held && held !== tab) throw new Error("tab closed: this thread has a newer tab");
    this.tabs.set(tab.id, tab);
    await this.makeRoom(tab);
    const ctx = this.ctx;
    if (!ctx) throw new Error("Browser closed while opening a tab");
    this.opening++;
    let page: any;
    try {
      page = await ctx.newPage();
      this.byPage.set(page, tab);
      tab.page = page;
    } finally {
      this.opening--;
      // Also when newPage() threw: pages that appeared meanwhile were not judged by the "page" handler.
      if (this.opening === 0) await this.closeStrays();
    }
    // WebSockets bypass context.route. The context-wide route (launchContext) covers every page, including the gap
    // before this line and popups; this page-level route only adds attribution to the tab.
    await page.routeWebSocket(/.*/, this.wsHandler((url, why) => tab.blockRecord(url, why)));
    return page;
  }

  private startSweeper() {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => { void this.sweepIdle(); }, Math.max(1000, Math.min(60_000, this.tabIdleMs / 4)));
    this.sweeper.unref?.();
  }
  private stopSweeper() {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
  }

  /** Close tabs idle longer than the timeout; the browser shuts down with its last tab. */
  async sweepIdle(): Promise<void> {
    // One clock reading for the whole sweep, so every tab is judged at the same instant.
    const t0 = this.now();
    for (const t of [...this.tabs.values()]) {
      if (t.busy === 0 && t0 - t.lastUsed >= this.tabIdleMs) await t.closeTab({ keepBrowser: true }).catch(() => undefined);
    }
    await this.closeIfEmpty();
  }

  async closeIfEmpty(): Promise<void> {
    if (this.ctx && ![...this.tabs.values()].some((t) => t.page || t.busy > 0)) await this.close();
  }

  /** Same WebSocket policy for every route; `record` says where a block is listed. */
  private wsHandler(record: (url: string, why: string | undefined) => void) {
    return async (ws: any) => {
      const url: string = ws.url();
      const v = await checkUrlResolved(url, { allowHosts: this.cfg.allowHosts, websocket: true }, this.resolver);
      if (!v.ok) {
        record(url, v.reason);
        await ws.close({ code: 1008, reason: "blocked by browser policy" }).catch(() => undefined);
        return;
      }
      ws.connectToServer();
    };
  }

  /** Close every page of the context that no tab owns. */
  private async closeStrays(): Promise<void> {
    for (const p of this.ctx?.pages() ?? []) if (!this.byPage.has(p)) await p.close().catch(() => undefined);
  }

  /** @internal Live pages in the browser context (tests: every one should belong to a tab). */
  pageCount(): number { return this.ctx ? this.ctx.pages().length : 0; }

  /** Record a block on the tab that owns the page, or on the session when no tab does. */
  private blockOn(tab: Tab | undefined, url: string, why: string | undefined) {
    if (tab) tab.blockRecord(url, why);
    else this.strayRecord(url, why);
  }

  private strayRecord(url: string, why: string | undefined) {
    this.stray.push(`${redactUrl(url)}: ${why}`);
    if (this.stray.length > 50) this.stray.shift();
  }

  /** @internal Blocks (HTTP and WebSocket) on pages without a tab: popups, strays. */
  strayBlocked(): string[] { return [...this.stray]; }

  /** @internal True when another Tab object now holds this thread's slot. */
  replaced(tab: Tab): boolean { const t = this.tabs.get(tab.id); return !!t && t !== tab; }

  forget(tab: Tab) { if (this.tabs.get(tab.id) === tab) this.tabs.delete(tab.id); }

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
          // Chromium's local-network-access check would refuse WebSockets to allowlisted loopback hosts. This flag is
          // global to the browser. Non-allowlisted private hosts stay blocked by the request/WebSocket policy, but
          // redirects on the native EventSource path are not vetted.
          "--disable-features=LocalNetworkAccessChecks",
        ],
      });
    } catch (err) {
      this.removeShotDir();
      throw new Error(`Browser failed to launch: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}. ${INSTALL_HINT}`);
    }
    this.ctx = ctx;
    // Installed before the old-page cleanup and the "page" handler: any page, including one restored from the profile
    // or opened as a popup, must never be able to open a socket before the policy exists.
    await ctx.routeWebSocket(/.*/, this.wsHandler((url, why) => {
      this.strayRecord(url, why);
    }));
    // Pages restored from the profile exist before any route is installed: close them first.
    for (const old of ctx.pages()) await old.close().catch(() => undefined);
    // Popups (window.open, target=_blank) are closed; registered ONCE per context, not per page.
    // Popups (window.open, target=_blank) and strays are closed. While a tab is inside newPage() any new page could be
    // its own, so nothing is judged then: closeStrays() runs when the last opening finishes and closes every page that
    // no tab owns, whatever its opener.
    // Known window: a popup that appears while a tab is opening a slow page is kept until closeStrays() runs. It is
    // guarded (context-wide HTTP and WebSocket routes apply) but its blocks are unattributed (listed via strayBlocked()).
    ctx.on("page", (p: any) => { if (this.opening === 0) p.close().catch(() => undefined); });
    ctx.on("close", () => {
      if (this.ctx !== ctx) return;
      this.ctx = undefined;
      this.stopSweeper();
      for (const t of this.tabs.values()) t.invalidate();
      this.tabs.clear();
      this.removeShotDir();
    });
    const allowHosts = this.cfg.allowHosts;
    const lookup = guardedLookup(allowHosts, this.resolver);
    // Every HTTP(S) request the page makes is performed in Node over a connect-time-vetted lookup (see fetcher.ts).
    await ctx.route(/.*/, async (route: any) => {
      const req = route.request();
      const url: string = req.url();
      const tab = this.tabOf(req);
      try {
        const v = await this.verdict(url, req.isNavigationRequest());
        if (!v.ok) {
          this.blockOn(tab, url, v.reason);
          return await route.abort("blockedbyclient").catch(() => undefined);
        }
        if (!/^https?:/i.test(url)) return await route.continue().catch(() => undefined);
        const parsed = new URL(url);
        // EventSource streams cannot pass through the Node fetcher, so an EventSource to an allowlisted host that is
        // also the page's own host is served by Chromium's own network stack. resourceType() comes from the browser
        // and page JS cannot forge it (unlike the Accept header). Redirects on this path are NOT vetted: Playwright
        // does not show the hop to this handler.
        // The host comparison ignores scheme and port, consistent with how allowHosts matches.
        if (req.resourceType() === "eventsource" && hostAllowed(parsed.hostname, allowHosts) && tab?.pageHost() === parsed.hostname) {
          return await route.continue().catch(() => undefined);
        }
        const method: string = req.method();
        const rawHeaders = (await req.allHeaders()) as Record<string, string>;
        const headers: Record<string, string> = {};
        for (const [k, val] of Object.entries(rawHeaders)) {
          const lk = k.toLowerCase();
          if (!HOP_BY_HOP.includes(lk) && lk !== "accept-encoding" && lk !== "cookie") headers[k] = val;
        }
        headers["accept-encoding"] = "identity";
        const body: Buffer | null = req.postDataBuffer();
        if (!["GET", "HEAD"].includes(method.toUpperCase()) && !body && /multipart|octet-stream/i.test(rawHeaders["content-type"] ?? "")) {
          this.blockOn(tab, url, "unsupported request body (file/blob upload cannot be read); aborted instead of sending it empty");
          return await route.abort("failed").catch(() => undefined);
        }
        const topLevel = req.isNavigationRequest() && !req.frame().parentFrame();
        const site = this.siteFor(tab, url, req, rawHeaders["sec-fetch-site"], topLevel);
        const jar = (await ctx.cookies(url)) as JarCookie[];
        const cookies = selectCookies(jar, { requestUrl: url, site, method, topLevelNavigation: topLevel });
        if (cookies.length) headers["cookie"] = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
        const res = await guardedFetch({
          url,
          method,
          headers,
          body,
          lookup,
          maxBytes: this.cfg.maxResponseBytes ?? DEFAULTS.maxResponseBytes,
          timeoutMs: this.timeout,
        });
        const loc = res.headers["location"];
        if (res.status >= 300 && res.status < 400 && typeof loc === "string") {
          const target = new URL(loc, url).toString();
          const rv = await this.verdict(target, req.isNavigationRequest());
          if (!rv.ok) {
            this.blockOn(tab, url, `redirect to ${redactUrl(target)}: ${rv.reason}`);
            return await route.abort("blockedbyclient").catch(() => undefined);
          }
        }
        const setCookies = res.headers["set-cookie"];
        if (setCookies) await storeCookies(ctx, url, Array.isArray(setCookies) ? setCookies : [setCookies]);
        const out: Record<string, string> = {};
        for (const [k, val] of Object.entries(res.headers)) {
          if (["set-cookie", "content-encoding", "connection", "keep-alive", "te", "trailer", "upgrade", "proxy-connection", "transfer-encoding", "content-length"].includes(k)) continue;
          out[k] = Array.isArray(val) ? val.join(", ") : String(val);
        }
        return await route.fulfill({ status: res.status, headers: out, body: res.body }).catch(() => undefined);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith("blocked:")) this.blockOn(tab, url, msg.slice(8).trim());
        else this.blockOn(tab, url, `request failed: ${msg}`);
        return route.abort(msg.startsWith("blocked:") ? "blockedbyclient" : "failed").catch(() => undefined);
      }
    });
  }

  /** Sec-Fetch-Site for a request: user navigations are "none"; frames are judged against EVERY ancestor. */
  private siteFor(tab: Tab | undefined, url: string, req: any, header: string | undefined, topLevel: boolean): FetchSite {
    const valid = (h?: string): h is FetchSite => h === "same-origin" || h === "same-site" || h === "cross-site" || h === "none";
    // A page no tab owns (stray, popup) has no navigation state to vouch for it: never "none".
    if (!tab) return "cross-site";
    if (topLevel) {
      const nav = tab.gotoNav;
      if (nav) {
        if (url === nav.url && nav.prev === "") { nav.prev = url; return "none"; }
        // redirect hop: relative to the previous hop; once any hop is cross-site the rest of the chain is too
        const rel = fetchSite(url, nav.prev, false);
        nav.prev = url;
        if (rel === "cross-site") nav.tainted = true;
        return nav.tainted ? "cross-site" : rel === "same-origin" ? "none" : rel;
      }
      if (valid(header)) return header;
      return fetchSite(url, tab.page?.url(), !tab.page?.url());
    }
    const sites: FetchSite[] = valid(header) ? [header] : [];
    let f = req.frame();
    sites.push(fetchSite(url, f.url(), false));
    while ((f = f.parentFrame())) sites.push(fetchSite(url, f.url(), false));
    return worstSite(sites);
  }

  /** Close the whole browser and delete all screenshots. Safe to call repeatedly. */
  close(): Promise<void> {
    const run: Promise<void> = this.closeNow().finally(() => { if (this.closing === run) this.closing = undefined; });
    this.closing = run;
    return run;
  }

  private async closeNow(): Promise<void> {
    if (this.ctxLaunching) await Promise.race([this.ctxLaunching.catch(() => undefined), new Promise((r) => setTimeout(r, 15_000))]);
    const ctx = this.ctx;
    this.ctx = undefined;
    this.stopSweeper();
    for (const t of this.tabs.values()) t.invalidate();
    this.tabs.clear();
    if (ctx) {
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        ctx.close().then(() => false, () => false),
        new Promise<boolean>((r) => { timer = setTimeout(() => r(true), 10_000); }),
      ]);
      clearTimeout(timer);
      if (timedOut) {
        // A wedged Chromium: kill the process itself rather than leak it.
        try { ctx.browser()?.process?.()?.kill("SIGKILL"); } catch { /* best effort */ }
        try { (ctx as any)._browser?._connection?.close?.(); } catch { /* best effort */ }
      }
    }
    this.removeShotDir();
  }
}

/** One thread's tab: its own queue, page, logs, blocked list and screenshots, in the shared browser context. */
export class Tab {
  page: any;
  chain: Promise<unknown> = Promise.resolve();
  busy = 0;
  /** Bumped by closeTab: calls queued before it fail with "tab closed". */
  private epoch = 0;
  lastUsed: number;
  consoleLog: ConsoleEntry[] = [];
  netLog: NetEntry[] = [];
  blocked: string[] = [];
  private shotFiles: string[] = [];
  private pageOpening?: Promise<void>;
  /** Set while browser_goto navigates: that request is user-typed ("none"); redirect hops are judged against the chain. */
  gotoNav?: { url: string; prev: string; tainted: boolean };

  constructor(private readonly sess: BrowserSession, readonly id: string) {
    this.lastUsed = sess.now();
  }

  /** Serialise `fn` after every earlier call of this thread; a failure does not poison the queue. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    this.busy++;
    this.lastUsed = this.sess.now();
    // A call still queued when its tab is closed (or replaced) fails instead of silently reopening the tab.
    const epoch = this.epoch;
    const guarded = () => {
      if (this.epoch !== epoch || this.sess.replaced(this)) return Promise.reject(new Error("tab closed"));
      return fn();
    };
    const next = this.chain.then(guarded, guarded);
    this.chain = next.then(() => undefined, () => undefined).then(() => { this.busy--; this.lastUsed = this.sess.now(); });
    return next;
  }

  blockRecord(url: string, why: string | undefined) {
    this.blocked.push(`${redactUrl(url)}: ${why}`);
    if (this.blocked.length > 50) this.blocked.shift();
  }

  /** Hostname of the tab's current URL, or undefined. */
  pageHost(): string | undefined {
    try { return new URL(this.page?.url() ?? "").hostname; } catch { return undefined; }
  }

  /** The whole browser is closing: calls still queued on this tab fail with "tab closed", and its state is dropped. */
  invalidate() {
    this.epoch++;
    this.reset();
  }

  /** Forget the page and logs without touching the browser (the browser itself is closing). */
  reset() {
    this.page = undefined;
    this.consoleLog = [];
    this.netLog = [];
    this.blocked = [];
    this.shotFiles = [];
  }

  private push<T>(arr: T[], item: T) {
    arr.push(item);
    if (arr.length > DEFAULTS.logCap) arr.shift();
  }

  private async ready() {
    if (!this.page) {
      this.pageOpening ??= this.openPage().finally(() => { this.pageOpening = undefined; });
      await this.pageOpening;
    }
    return this.page;
  }

  private async openPage(): Promise<void> {
    const page = await this.sess.newPage(this);
    this.page = page;
    page.setDefaultTimeout(this.sess.timeout);
    const gone = () => { if (this.page === page) this.page = undefined; };
    page.on("close", gone);
    page.on("crash", () => { gone(); page.close().catch(() => undefined); });
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

  async goto(url: string, waitUntil: "load" | "domcontentloaded" | "networkidle" | "commit" = "load", timeoutMs?: number): Promise<string> {
    const v = await this.sess.verdict(url, true);
    if (!v.ok) throw new Error(`Navigation blocked: ${v.reason}`);
    const page = await this.ready();
    const before = this.blocked.length;
    let status: number | undefined;
    this.gotoNav = { url: new URL(url).toString(), prev: "", tainted: false };
    try {
      const go = () => page.goto(url, { waitUntil, timeout: timeoutMs ?? this.sess.timeout });
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
    } finally {
      this.gotoNav = undefined;
    }
    // Belt and braces: whatever we ended on (redirects, JS) must pass too.
    const final = page.url();
    const fv = await this.sess.verdict(final, true);
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
    // A busy loop wedges the renderer and page.evaluate never settles: race it, and drop the page so the queue moves on.
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      page.evaluate(expression),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          if (this.page === page) this.page = undefined;
          page.close({ runBeforeUnload: false }).catch(() => undefined);
          reject(new Error(`browser_eval timed out after ${this.sess.timeout}ms; the page was closed (the next call opens a fresh one)`));
        }, this.sess.timeout);
      }),
    ]).finally(() => clearTimeout(timer));
    let text: string;
    try {
      text = result === undefined ? "undefined" : typeof result === "string" ? result : JSON.stringify(result, null, 2);
    } catch {
      text = String(result);
    }
    return capText(text ?? "undefined", this.sess.max);
  }

  async screenshot(fullPage = false): Promise<string> {
    const page = await this.ready();
    const file = join(this.sess.ensureShotDir(), `shot-${this.id.replace(/[^\w-]/g, "_")}-${this.sess.nextShot()}.png`);
    await page.screenshot({ path: file, fullPage });
    this.shotFiles.push(file);
    return file;
  }

  console(opts: { limit?: number; filter?: string; clear?: boolean }): string {
    const f = opts.filter?.toLowerCase();
    const rows = this.consoleLog.filter((e) => !f || e.text.toLowerCase().includes(f) || e.type.includes(f));
    const out = lastN(rows, opts.limit, 200).map((e) => `${e.t} [${e.type}] ${e.text}`).join("\n");
    if (opts.clear) this.consoleLog = [];
    return capText(out || "(no console messages)", this.sess.max);
  }

  network(opts: { limit?: number; urlFilter?: string; status?: number; clear?: boolean }): string {
    const rows = this.netLog.filter((e) => (!opts.urlFilter || e.url.includes(opts.urlFilter)) && (opts.status === undefined || e.status === opts.status));
    const out = lastN(rows, opts.limit, 200).map((e) => JSON.stringify(e)).join("\n");
    if (opts.clear) this.netLog = [];
    return capText(out || "(no network entries)", this.sess.max);
  }

  blockedRequests(): string[] { return [...this.blocked]; }

  /** Close only this thread's tab (its page, logs and screenshots). The browser closes with its last tab. */
  async closeTab(opts: { keepBrowser?: boolean } = {}): Promise<void> {
    this.epoch++;
    const page = this.page;
    this.page = undefined;
    for (const f of this.shotFiles) rmSync(f, { force: true });
    this.reset();
    this.sess.forget(this);
    if (page) await page.close({ runBeforeUnload: false }).catch(() => undefined);
    if (!opts.keepBrowser) await this.sess.closeIfEmpty();
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
      if (e?.code === "ESRCH") {
        try { rmSync(join(tmpdir(), n), { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
  }
}

/** Validate each Set-Cookie (see cookies.ts) and store the survivors in the context's jar. */
async function storeCookies(ctx: any, url: string, headers: string[]) {
  const host = new URL(url).hostname;
  for (const h of headers) {
    const c = parseSetCookie(h, url);
    if (!c) continue;
    const cookie: Record<string, unknown> = {
      name: c.name,
      value: c.value,
      domain: c.domain ?? host,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      ...(c.sameSite ? { sameSite: c.sameSite } : {}),
      ...(c.expires !== undefined ? { expires: c.expires } : {}),
    };
    await ctx.addCookies([cookie]).catch(() => undefined);
  }
}
