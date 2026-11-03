/**
 * One lazily launched, guarded Chromium for a wolf. All calls run through a single queue on a single page.
 * Playwright is imported lazily so a wolf that never uses the browser (or a host without the binary) loads fine.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, chmodSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { capText, checkUrlResolved, lastN, redactHeaders, redactUrl, type Resolver } from "./policy.js";

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
}

export const DEFAULTS = { timeoutMs: 30_000, maxOutputChars: 20_000, logCap: 500 };

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

  private async doLaunch(): Promise<void> {
    const headless = !this.cfg.headed;
    const found = findBrowser(this.cfg, headless);
    if (!found) throw new Error(INSTALL_HINT);
    const { chromium } = await import("playwright-core");
    mkdirSync(join(this.den, "state"), { recursive: true });
    mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
    chmodSync(this.profileDir, 0o700);
    this.shotDir = mkdtempSync(join(tmpdir(), "wolf-browser-"));
    try {
      this.ctx = await chromium.launchPersistentContext(this.profileDir, {
        headless,
        ...(found.executablePath ? { executablePath: found.executablePath } : {}),
        ...(found.channel ? { channel: found.channel } : {}),
        viewport: { width: 1280, height: 800 },
        acceptDownloads: false,
        serviceWorkers: "block",
        args: ["--no-first-run", "--no-default-browser-check", "--disable-extensions"],
      });
    } catch (err) {
      rmSync(this.shotDir, { recursive: true, force: true });
      this.shotDir = undefined;
      throw new Error(`Browser failed to launch: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}. ${INSTALL_HINT}`);
    }
    // Every request the page makes (navigations, redirects, subresources) passes the URL policy.
    await this.ctx.route("**/*", async (route: any) => {
      const req = route.request();
      const v = await this.verdict(req.url(), req.isNavigationRequest());
      if (v.ok) return route.continue();
      this.blocked.push(`${redactUrl(req.url())}: ${v.reason}`);
      if (this.blocked.length > 50) this.blocked.shift();
      return route.abort("blockedbyclient");
    });
    this.page = this.ctx.pages()[0] ?? (await this.ctx.newPage());
    this.page.setDefaultTimeout(this.timeout);
    this.page.on("console", (m: any) => this.push(this.consoleLog, { t: new Date().toISOString(), type: m.type(), text: m.text() }));
    this.page.on("pageerror", (e: Error) => this.push(this.consoleLog, { t: new Date().toISOString(), type: "pageerror", text: String(e.message) }));
    const byReq = new Map<any, NetEntry>();
    this.page.on("request", (r: any) => {
      const e: NetEntry = { method: r.method(), url: redactUrl(r.url()), requestHeaders: redactHeaders(r.headers()) };
      byReq.set(r, e);
      this.push(this.netLog, e);
    });
    this.page.on("response", (r: any) => {
      const e = byReq.get(r.request());
      if (e) { e.status = r.status(); e.responseHeaders = redactHeaders(r.headers()); }
    });
    this.page.on("requestfailed", (r: any) => {
      const e = byReq.get(r);
      if (e) e.failure = r.failure()?.errorText ?? "failed";
    });
    this.ctx.on("close", () => { this.ctx = undefined; this.page = undefined; });
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
      const res = await page.goto(url, { waitUntil, timeout: timeoutMs ?? this.timeout });
      status = res?.status();
    } catch (err) {
      const newly = this.blocked.slice(before);
      if (newly.length) throw new Error(`Navigation blocked: ${newly.join("; ")}`);
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
    const file = join(this.shotDir!, `shot-${++this.shots}.png`);
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
    if (this.shotDir) rmSync(this.shotDir, { recursive: true, force: true });
    this.shotDir = undefined;
  }
}
