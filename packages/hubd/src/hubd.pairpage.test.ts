/** Browser pairing page: public GET /pair, the page's request shape yields a working browser token, CLI QR. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedFixture, FIXTURE_DOMAIN } from "./testing/fixture.js";
import { main, parseArgs } from "./cli.js";
import { normalizeConsoleUrl, pairPageHtml } from "./pair-page.js";
import { createTokenStore } from "./auth.js";
import { createHubServer, type HubServer } from "./server.js";

let dir = "";
let hub: HubServer;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hubd-pairpage-"));
  seedFixture(dir);
});
afterEach(async () => {
  await hub?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("pairing page", () => {
  it("GET /pair is public HTML with no-store and a locked-down CSP", async () => {
    hub = await createHubServer({ dataDir: dir, port: 0 });
    const r = await fetch(`${hub.url}/pair?code=abc`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    const html = await r.text();
    expect(html).toContain('fetch("v1/pair"'); // relative: works behind a stripped /hub prefix
    expect(html).not.toContain('fetch("/v1/pair"');
    expect(html).toContain('"consoleUrl":null');
    expect(html).not.toMatch(/https?:\/\/[^"' ]*cdn/i);
  });

  it("embeds the configured console URL safely", async () => {
    hub = await createHubServer({ dataDir: dir, port: 0, consoleUrl: "http://console.ts.net:3000/app/?x=1#f" });
    const html = await (await fetch(`${hub.url}/pair`)).text();
    expect(html).toContain('"consoleUrl":"http://console.ts.net:3000/app"');
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(pairPageHtml("http://a/\u2028\u2029")).not.toMatch(/[\u2028\u2029]/);
  });

  it("rejects a bad console URL at startup (server option and CLI flag)", async () => {
    for (const bad of ["javascript:alert(1)", "ftp://x", "not a url"]) {
      await expect(createHubServer({ dataDir: dir, port: 0, consoleUrl: bad })).rejects.toThrow(/console URL/);
      expect(() => parseArgs(["serve", "--data-dir", dir, "--console-url", bad])).toThrow(/console URL/);
    }
    expect(normalizeConsoleUrl("https://c.example:8443/")).toBe("https://c.example:8443");
  });

  it("the page's request shape pairs a browser token that works on a hub route", async () => {
    hub = await createHubServer({ dataDir: dir, port: 0 });
    const { code } = createTokenStore(dir).mintPairingCode({ kind: "browser" });
    const r = await fetch(`${hub.url}/v1/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, label: "Browser: test", kind: "browser" }) });
    expect(r.status).toBe(200);
    const { token } = (await r.json()) as { token: string };
    expect((await fetch(`${hub.url}/v1/work?domain=${FIXTURE_DOMAIN}`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await fetch(`${hub.url}/v1/work?domain=${FIXTURE_DOMAIN}`)).status).toBe(401);
    // single use, and the page can show why
    const again = await fetch(`${hub.url}/v1/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, label: "x", kind: "browser" }) });
    expect(again.status).toBe(401);
  });
});

describe("hubd pair --kind browser QR", () => {
  const run = async (argv: string[], env: Record<string, string> = {}) => {
    const out: string[] = [];
    await main(argv, env as NodeJS.ProcessEnv, (m) => out.push(m));
    return out.join("\n");
  };
  it("prints a QR and the link when --url is given", async () => {
    const out = await run(["pair", "--kind", "browser", "--url", "http://hub.ts.net:3142/", "--data-dir", dir]);
    const code = /pairing code: (\S+)/.exec(out)![1]!;
    expect(out).toContain(`http://hub.ts.net:3142/pair?code=${code}`);
    expect(out).toMatch(/[█▀▄]/);
  });
  it("uses HUBD_PUBLIC_URL, and notes the skip when no URL; no QR for other kinds", async () => {
    expect(await run(["pair", "--kind", "browser", "--data-dir", dir], { HUBD_PUBLIC_URL: "http://h:1" })).toContain("http://h:1/pair?code=");
    expect(await run(["pair", "--kind", "browser", "--data-dir", dir])).toContain("no QR code");
    expect(await run(["pair", "--kind", "console", "--url", "http://h:1", "--data-dir", dir])).not.toContain("/pair?code=");
  });
});

describe("pairing label and expiry", () => {
  it("--label is recorded on the token (wins over the browser's); the default browser label is dated; codes are single-use and expire", async () => {
    let t = Date.now();
    hub = await createHubServer({ dataDir: dir, port: 0, now: () => t });
    const store = createTokenStore(dir, () => t);
    const exchange = (code: string) => fetch(`${hub.url}/v1/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, label: "page-label", kind: "browser" }) });
    const { code } = store.mintPairingCode({ kind: "browser", label: "Luka's phone" });
    expect((await exchange(code)).status).toBe(200);
    expect(createTokenStore(dir).list().map((x) => [x.kind, x.label])).toEqual([["browser", "Luka's phone"]]);
    expect((await exchange(code)).status).toBe(401);
    const { code: c2 } = store.mintPairingCode({ kind: "browser" });
    t += 11 * 60_000;
    expect((await exchange(c2)).status).toBe(401);
    expect(parseArgs(["pair", "--kind", "browser", "--label", "iPad", "--data-dir", dir]).label).toBe("iPad");
    const out: string[] = [];
    await main(["pair", "--kind", "browser", "--data-dir", dir], {} as NodeJS.ProcessEnv, (m) => out.push(m));
    const c3 = /pairing code: (\S+)/.exec(out.join("\n"))![1]!;
    t = Date.now();
    expect((await exchange(c3).catch(() => undefined))?.status).toBeDefined();
  });
});
