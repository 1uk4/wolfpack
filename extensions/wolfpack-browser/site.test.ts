import { describe, expect, it } from "vitest";
import { BrowserSession } from "./session.js";

const frame = (url: string, parent?: any): any => ({ url: () => url, parentFrame: () => parent ?? null });
const make = () => new BrowserSession("/nonexistent", {}) as any;

describe("BrowserSession.siteFor", () => {
  it("a navigation started by browser_goto is 'none', even with about:blank as the page", () => {
    const s = make();
    const t: any = { page: { url: () => "about:blank" } };
    t.gotoNav = { url: "https://www.example.com/", prev: "", tainted: false };
    expect(s.siteFor(t, "https://www.example.com/", { frame: () => frame("about:blank") }, undefined, true)).toBe("none");
  });
  it("redirect hops: same-site stays same-site, a cross-site hop taints the rest of the chain", () => {
    const s = make();
    const t: any = {};
    t.gotoNav = { url: "https://example.com/", prev: "", tainted: false };
    expect(s.siteFor(t, "https://example.com/", {}, undefined, true)).toBe("none");
    expect(s.siteFor(t, "https://www.example.com/", {}, undefined, true)).toBe("same-site");
    expect(s.siteFor(t, "https://evil.net/", {}, undefined, true)).toBe("cross-site");
    expect(s.siteFor(t, "https://example.com/back", {}, undefined, true)).toBe("cross-site");
  });
  it("a subframe request is cross-site if ANY ancestor is cross-site", () => {
    const s = make();
    const t: any = {};
    const top = frame("https://evil.net/");
    const mid = frame("https://api.example.com/", top); // same-site as the request, but its parent is not
    const leaf = frame("https://api.example.com/inner", mid);
    expect(s.siteFor(t, "https://api.example.com/x", { frame: () => leaf }, undefined, false)).toBe("cross-site");
    const okTop = frame("https://www.example.com/");
    const okLeaf = frame("https://api.example.com/inner", okTop);
    expect(s.siteFor(t, "https://api.example.com/x", { frame: () => okLeaf }, undefined, false)).toBe("same-site");
  });
  it("a request from a page no tab owns is never 'none'", () => {
    const s = make();
    expect(s.siteFor(undefined, "https://example.com/", { frame: () => frame("about:blank") }, undefined, true)).toBe("cross-site");
    expect(s.siteFor(undefined, "https://example.com/x", { frame: () => frame("https://example.com/") }, "none", true)).toBe("cross-site");
  });
});
