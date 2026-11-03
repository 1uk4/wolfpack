import { describe, expect, it } from "vitest";
import { REDACTED, capText, checkUrl, checkUrlResolved, guardedLookup, lastN, redactHeaders, redactUrl } from "./policy.js";

describe("checkUrl", () => {
  it.each([
    "https://example.com/a?b=1",
    "http://example.org",
    "https://8.8.8.8/",
    "https://172.32.0.1/",
    "https://198.20.0.1/",
    "https://223.255.255.254/",
    "https://[64:ff9b::808:808]/", // NAT64 -> 8.8.8.8
    "https://[2002:808:808::1]/",
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
    "http://0177.0.0.1/", // octal
    "http://0x7f.0.0.1/", // hex
    "http://0x7f000001/",
    "http://127.1/",
    "http://127.0.0.1./",
    "http://localhost./",
    "http://[::ffff:7f00:1]/",
    "http://[64:ff9b::7f00:1]/", // NAT64 -> 127.0.0.1
    "http://[64:ff9b:1::1]/",
    "http://[2002:7f00:1::]/", // 6to4 -> 127.0.0.1
    "http://[2002:a9fe:a9fe::1]/", // 6to4 -> 169.254.169.254
    "http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/", // Teredo
    "http://[fec0::1]/",
    "http://[ff02::1]/",
    "http://192.0.0.1/",
    "http://198.18.0.1/",
    "http://198.19.255.255/",
    "http://224.0.0.1/",
    "http://240.0.0.1/",
    "http://255.255.255.255/",
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
  it("resolver errors and empty answers FAIL CLOSED", async () => {
    const err = await checkUrlResolved("http://nx.example.com/", {}, async () => { throw new Error("ENOTFOUND"); });
    expect(err.ok).toBe(false);
    expect(err.reason).toMatch(/fail closed/);
    expect((await checkUrlResolved("http://nx.example.com/", {}, async () => [])).ok).toBe(false);
  });
  it("ws/wss are judged like http only when asked", async () => {
    expect(checkUrl("ws://127.0.0.1:1/").ok).toBe(false);
    expect(checkUrl("ws://127.0.0.1:1/", { websocket: true }).ok).toBe(false);
    expect(checkUrl("ws://127.0.0.1:1/", { websocket: true, allowHosts: ["127.0.0.1"] }).ok).toBe(true);
    expect(checkUrl("wss://example.com/", { websocket: true }).ok).toBe(true);
    expect(checkUrl("wss://example.com/").ok).toBe(false);
  });
});

describe("guardedLookup (connect-time)", () => {
  const call = (host: string, allow: string[], resolve: (h: string) => Promise<string[]>, opts: object = {}) =>
    new Promise<{ err: Error | null; res?: unknown; fam?: number }>((done) =>
      guardedLookup(allow, resolve)(host, opts, (err: Error | null, res?: unknown, fam?: number) => done({ err, res, fam })));

  it("rejects a name whose address is internal at connect time (rebinding)", async () => {
    let n = 0; // first answer public, second internal: each connect re-resolves and is judged on ITS answer
    const resolve = async () => (n++ === 0 ? ["93.184.216.34"] : ["127.0.0.1"]);
    expect((await call("rebind.example.com", [], resolve)).err).toBeNull();
    const second = await call("rebind.example.com", [], resolve);
    expect(second.err?.message).toMatch(/blocked/);
  });
  it("returns the vetted addresses in both lookup shapes", async () => {
    const r = async () => ["93.184.216.34"];
    expect((await call("a.example.com", [], r)).res).toBe("93.184.216.34");
    expect((await call("a.example.com", [], r, { all: true })).res).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });
  it("fails closed on resolver error and empty answers; allowlist bypasses the address check", async () => {
    expect((await call("x.example.com", [], async () => { throw new Error("boom"); })).err?.message).toMatch(/blocked/);
    expect((await call("x.example.com", [], async () => [])).err).not.toBeNull();
    expect((await call("dev.example.com", ["dev.example.com"], async () => ["10.0.0.5"])).err).toBeNull();
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
  it("redacts by pattern, not a fixed list", () => {
    const out = redactHeaders({ "X-Auth-Token": "a", "x-csrf-token": "b", "x-session-id": "c", "X-Secret": "d", "x-goog-api-key": "e", "content-type": "text/plain" });
    expect(Object.values(out).filter((v) => v === REDACTED)).toHaveLength(5);
    expect(out["content-type"]).toBe("text/plain");
  });
  it("masks credential-looking query values and drops the fragment", () => {
    const out = redactUrl("https://example.com/cb?code=abc&access_token=t&page=2&apikey=k#id_token=zzz");
    expect(out).toMatch(/page=2/);
    expect(out).not.toMatch(/abc|=t&|=k|zzz|#/);
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
