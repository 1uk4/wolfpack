import { describe, expect, it } from "vitest";
import { defaultPath, fetchSite, isPublicSuffix, parseSetCookie, selectCookies, siteOf, worstSite, type JarCookie } from "./cookies.js";

const ck = (o: Partial<JarCookie> & { name: string }): JarCookie => ({ value: "v", domain: ".example.com", path: "/", ...o });
const names = (c: JarCookie[]) => c.map((x) => x.name).sort();
const jar = [ck({ name: "strict", sameSite: "Strict" }), ck({ name: "lax", sameSite: "Lax" }), ck({ name: "none", sameSite: "None", secure: true }), ck({ name: "unset" })];
const base = { requestUrl: "https://www.example.com/a", method: "GET" };

describe("selectCookies", () => {
  it("same-origin and user-typed navigations get everything that matches", () => {
    expect(names(selectCookies(jar, { ...base, site: "same-origin", topLevelNavigation: false }))).toEqual(["lax", "none", "strict", "unset"]);
    expect(names(selectCookies(jar, { ...base, site: "none", topLevelNavigation: true }))).toEqual(["lax", "none", "strict", "unset"]);
  });
  it("same-site requests (www -> api) send Strict and Lax cookies too, navigation or not", () => {
    for (const topLevelNavigation of [true, false]) {
      expect(names(selectCookies(jar, { ...base, site: "same-site", topLevelNavigation }))).toEqual(["lax", "none", "strict", "unset"]);
    }
  });
  it("cross-site navigations never send Strict; Lax only on GET", () => {
    expect(names(selectCookies(jar, { ...base, site: "cross-site", topLevelNavigation: true }))).toEqual(["lax", "none", "unset"]);
    expect(names(selectCookies(jar, { ...base, site: "cross-site", topLevelNavigation: true, method: "POST" }))).toEqual(["none"]);
  });
  it("cross-site subresources carry NO cookies (third-party blocking)", () => {
    expect(selectCookies(jar, { ...base, site: "cross-site", topLevelNavigation: false })).toEqual([]);
  });
  it("still applies secure, domain, path and expiry", () => {
    const j = [ck({ name: "sec", secure: true }), ck({ name: "host", domain: "www.example.com" }), ck({ name: "other", domain: ".evil.com" }), ck({ name: "p", path: "/zzz" }), ck({ name: "old", expires: 1 })];
    expect(names(selectCookies(j, { requestUrl: "http://www.example.com/a", method: "GET", site: "same-origin", topLevelNavigation: false }))).toEqual(["host"]);
    expect(names(selectCookies(j, { requestUrl: "https://www.example.com/a", method: "GET", site: "same-origin", topLevelNavigation: false }))).toEqual(["host", "sec"]);
    expect(names(selectCookies(j, { requestUrl: "https://notexample.com/a", method: "GET", site: "same-origin", topLevelNavigation: false }))).toEqual([]);
  });
});

describe("fetchSite / siteOf", () => {
  it("classifies", () => {
    expect(fetchSite("https://a.example.com/x", "https://a.example.com/y", false)).toBe("same-origin");
    expect(fetchSite("https://b.example.com/x", "https://a.example.com/y", false)).toBe("same-site");
    expect(fetchSite("https://evil.com/x", "https://a.example.com/y", false)).toBe("cross-site");
    expect(fetchSite("https://a.co.uk/x", "https://b.co.uk/y", false)).toBe("cross-site");
    expect(fetchSite("https://x.com/", undefined, true)).toBe("none");
    expect(siteOf("a.b.example.co.uk")).toBe("example.co.uk");
  });
});

describe("parseSetCookie", () => {
  const u = "https://www.example.com/app/login";
  it("accepts a plain cookie with the default path from the request", () => {
    expect(parseSetCookie("a=b", u)).toMatchObject({ name: "a", value: "b", path: "/app", secure: false });
    expect(defaultPath("/")).toBe("/");
    expect(defaultPath("/x")).toBe("/");
    expect(defaultPath("/x/y")).toBe("/x");
    expect(defaultPath("")).toBe("/");
  });
  it("Domain must domain-match the request host", () => {
    expect(parseSetCookie("a=b; Domain=example.com", u)?.domain).toBe(".example.com");
    expect(parseSetCookie("a=b; Domain=www.example.com", u)?.domain).toBe(".www.example.com");
    expect(parseSetCookie("a=b; Domain=evil.com", u)).toBeUndefined();
    expect(parseSetCookie("a=b; Domain=ample.com", u)).toBeUndefined();
    expect(parseSetCookie("a=b; Domain=api.example.com", u)).toBeUndefined();
  });
  it("rejects dotless and public-suffix domains", () => {
    expect(parseSetCookie("a=b; Domain=com", "https://example.com/")).toBeUndefined();
    expect(parseSetCookie("a=b; Domain=localhost", "http://localhost/")).toBeUndefined();
    expect(parseSetCookie("a=b; Domain=co.uk", "https://x.co.uk/")).toBeUndefined();
    expect(parseSetCookie("a=b; Domain=github.io", "https://me.github.io/")).toBeUndefined();
    expect(parseSetCookie("a=b; Domain=.ts.net", "https://box.ts.net/")).toBeUndefined();
    expect(isPublicSuffix("com")).toBe(true);
    expect(isPublicSuffix("example.com")).toBe(false);
  });
  it("__Secure- and __Host- prefix rules", () => {
    expect(parseSetCookie("__Secure-a=1", u)).toBeUndefined();
    expect(parseSetCookie("__Secure-a=1; Secure", u)).toBeDefined();
    expect(parseSetCookie("__Secure-a=1; Secure", "http://www.example.com/")).toBeUndefined();
    expect(parseSetCookie("__Host-a=1; Secure; Path=/", u)).toBeDefined();
    expect(parseSetCookie("__Host-a=1; Secure", u)).toBeUndefined(); // default path /app, not /
    expect(parseSetCookie("__Host-a=1; Secure; Path=/; Domain=example.com", u)).toBeUndefined();
    expect(parseSetCookie("__Host-a=1; Path=/", u)).toBeUndefined();
    expect(parseSetCookie("__host-a=1; Path=/", u)).toBeUndefined();
  });
  it("SameSite=None requires Secure", () => {
    expect(parseSetCookie("a=b; SameSite=None", u)).toBeUndefined();
    expect(parseSetCookie("a=b; SameSite=None; Secure", u)?.sameSite).toBe("None");
    expect(parseSetCookie("a=b; SameSite=strict", u)?.sameSite).toBe("Strict");
  });
  it("keeps '=' inside values and attribute values", () => {
    expect(parseSetCookie("a=b=c==; Path=/x=y", u)).toMatchObject({ value: "b=c==", path: "/x=y" });
  });
  it("Max-Age wins over Expires; malformed pairs are rejected", () => {
    expect(parseSetCookie("a=b; Max-Age=60; Expires=Wed, 21 Oct 2015 07:28:00 GMT", u, 1_000_000)?.expires).toBe(1060);
    expect(parseSetCookie("=b", u)).toBeUndefined();
    expect(parseSetCookie("novalue", u)).toBeUndefined();
  });
  it("a bare IP host may only scope to itself", () => {
    expect(parseSetCookie("a=b; Domain=10.0.0.5", "http://10.0.0.5/")?.domain).toBe(".10.0.0.5");
    expect(parseSetCookie("a=b; Domain=0.5", "http://10.0.0.5/")).toBeUndefined();
  });
});

describe("ancestor frames", () => {
  it("worstSite: any cross-site ancestor makes the request cross-site", () => {
    expect(worstSite(["same-origin", "cross-site", "same-site"])).toBe("cross-site");
    expect(worstSite(["same-origin", "same-site"])).toBe("same-site");
    expect(worstSite(["same-origin"])).toBe("same-origin");
  });
});

describe("public suffix list (tldts)", () => {
  it("covers suffixes the old hand list missed", () => {
    for (const d of ["com.ua", "co.id", "com.ar", "com.pl", "co.uk", "github.io", "vercel.app"]) expect(isPublicSuffix(d)).toBe(true);
    expect(isPublicSuffix("evil.com.ua")).toBe(false);
  });
  it("evil.com.ua cannot set Domain=com.ua; siteOf uses eTLD+1", () => {
    expect(parseSetCookie("a=b; Domain=com.ua", "https://evil.com.ua/")).toBeUndefined();
    expect(parseSetCookie("a=b; Domain=evil.com.ua", "https://www.evil.com.ua/")?.domain).toBe(".evil.com.ua");
    expect(siteOf("a.b.evil.com.ua")).toBe("evil.com.ua");
    expect(siteOf("x.example.com")).toBe("example.com");
    expect(fetchSite("https://a.com.ua/", "https://b.com.ua/", false)).toBe("cross-site");
  });
});

describe("Secure over http", () => {
  it("rejects Secure cookies from http: responses, except loopback", () => {
    expect(parseSetCookie("a=b; Secure", "http://www.example.com/")).toBeUndefined();
    expect(parseSetCookie("a=b; Secure", "https://www.example.com/")).toBeDefined();
    expect(parseSetCookie("a=b; Secure", "http://127.0.0.1:3000/")).toBeDefined();
    expect(parseSetCookie("a=b; Secure", "http://localhost/")).toBeDefined();
  });
});
