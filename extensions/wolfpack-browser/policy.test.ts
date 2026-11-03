import { describe, expect, it } from "vitest";
import { REDACTED, capText, checkUrl, checkUrlResolved, lastN, redactHeaders, redactUrl } from "./policy.js";

describe("checkUrl", () => {
  it.each([
    "https://example.com/a?b=1",
    "http://example.org",
    "https://8.8.8.8/",
    "https://172.32.0.1/",
    "https://100.63.0.1/",
    "https://[2606:4700::1111]/",
    "about:blank",
  ])("allows %s", (u) => expect(checkUrl(u).ok).toBe(true));

  it.each([
    "file:///etc/passwd",
    "chrome://settings",
    "about:config",
    "data:text/html,<b>x</b>",
    "javascript:alert(1)",
    "ftp://example.com",
    "not a url",
    "http://localhost:3000",
    "http://foo.localhost",
    "http://127.0.0.1:8080",
    "http://127.1.2.3",
    "http://0.0.0.0",
    "http://10.1.2.3",
    "http://172.16.0.1",
    "http://172.31.255.255",
    "http://192.168.1.1",
    "http://169.254.169.254/latest/meta-data",
    "http://100.64.0.1",
    "http://100.127.255.255",
    "http://mac.tail1234.ts.net",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:10.0.0.1]/",
    "http://[fe80::1]/",
    "http://[fd00::1]/",
    "http://printer.local",
    "http://2130706433/", // decimal 127.0.0.1: URL parser normalises it
  ])("blocks %s", (u) => expect(checkUrl(u).ok).toBe(false));

  it("explains the block", () => {
    expect(checkUrl("http://10.0.0.1").reason).toMatch(/allowHosts/);
  });

  it("allowlist: exact host, IP, and suffix", () => {
    expect(checkUrl("http://127.0.0.1:9", { allowHosts: ["127.0.0.1"] }).ok).toBe(true);
    expect(checkUrl("http://localhost:9", { allowHosts: ["127.0.0.1"] }).ok).toBe(false);
    expect(checkUrl("http://box.tail1.ts.net", { allowHosts: ["*.tail1.ts.net"] }).ok).toBe(true);
    expect(checkUrl("http://box.tail2.ts.net", { allowHosts: ["*.tail1.ts.net"] }).ok).toBe(false);
  });

  it("allowlist never re-enables blocked schemes", () => {
    expect(checkUrl("file:///etc/passwd", { allowHosts: ["*"] }).ok).toBe(false);
  });

  it("data: is tolerated only for non-navigation subresources", () => {
    expect(checkUrl("data:image/png;base64,AAAA", { navigation: false }).ok).toBe(true);
    expect(checkUrl("data:image/png;base64,AAAA", { navigation: true }).ok).toBe(false);
  });
});

describe("checkUrlResolved (redirect / DNS rebinding)", () => {
  it("blocks a public name that resolves to an internal address", async () => {
    const v = await checkUrlResolved("http://evil.example.com/", {}, async () => ["93.184.216.34", "127.0.0.1"]);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/resolves to 127.0.0.1/);
  });
  it("allows names resolving publicly, and when allowlisted", async () => {
    expect((await checkUrlResolved("http://ok.example.com/", {}, async () => ["93.184.216.34"])).ok).toBe(true);
    expect((await checkUrlResolved("http://dev.example.com/", { allowHosts: ["dev.example.com"] }, async () => ["10.0.0.5"])).ok).toBe(true);
  });
  it("a redirect target is checked like any URL", async () => {
    // The route handler runs the same check on every redirect hop's URL.
    expect((await checkUrlResolved("http://169.254.169.254/", {}, async () => [])).ok).toBe(false);
  });
  it("lookup failure does not block (the browser fails it itself)", async () => {
    expect((await checkUrlResolved("http://nx.example.com/", {}, async () => { throw new Error("ENOTFOUND"); })).ok).toBe(true);
  });
});

describe("redaction", () => {
  it("redacts credential headers case-insensitively and keeps the rest", () => {
    const out = redactHeaders({
      Authorization: "Bearer sekrit",
      cookie: "sid=1",
      "Set-Cookie": "sid=2",
      "proxy-authorization": "Basic x",
      "X-Api-Key": "k",
      apikey: "k2",
      accept: "text/html",
    });
    expect(out.Authorization).toBe(REDACTED);
    expect(out.cookie).toBe(REDACTED);
    expect(out["Set-Cookie"]).toBe(REDACTED);
    expect(out["proxy-authorization"]).toBe(REDACTED);
    expect(out["X-Api-Key"]).toBe(REDACTED);
    expect(out.apikey).toBe(REDACTED);
    expect(out.accept).toBe("text/html");
    expect(JSON.stringify(out)).not.toMatch(/sekrit|sid=|Basic x/);
  });
  it("strips URL credentials", () => {
    expect(redactUrl("https://u:pw@example.com/x")).not.toMatch(/pw/);
    expect(redactUrl("https://example.com/x")).toBe("https://example.com/x");
  });
});

describe("output caps", () => {
  it("capText truncates with a marker and leaves short text alone", () => {
    expect(capText("abc", 10)).toBe("abc");
    const out = capText("x".repeat(100), 10);
    expect(out.startsWith("x".repeat(10))).toBe(true);
    expect(out).toMatch(/truncated 90 of 100/);
  });
  it("lastN keeps the newest and clamps the limit", () => {
    const items = Array.from({ length: 300 }, (_, i) => i);
    expect(lastN(items, 3, 200)).toEqual([297, 298, 299]);
    expect(lastN(items, 9999, 200)).toHaveLength(200);
    expect(lastN(items, undefined, 200)).toHaveLength(50);
    expect(lastN(items, -5, 200)).toHaveLength(50);
  });
});
