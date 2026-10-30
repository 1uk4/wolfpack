/** Browser pairing page: public GET /pair, the page's request shape yields a working browser token, CLI QR. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedFixture, FIXTURE_DOMAIN } from "./testing/fixture.js";
import { main } from "./cli.js";
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
    const html = await r.text();
    expect(html).toContain("/v1/pair");
    expect(html).toContain('"consoleUrl":null');
    expect(html).not.toMatch(/https?:\/\/[^"' ]*cdn/i);
  });

  it("embeds the configured console URL safely", async () => {
    hub = await createHubServer({ dataDir: dir, port: 0, consoleUrl: "http://console.ts.net:3000</script>" });
    const html = await (await fetch(`${hub.url}/pair`)).text();
    expect(html).toContain("http://console.ts.net:3000\\u003c/script>");
    expect(html.match(/<\/script>/g)).toHaveLength(1);
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
