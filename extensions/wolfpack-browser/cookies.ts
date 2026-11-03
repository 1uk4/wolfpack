/**
 * Cookie rules for the Node fetch path. The browser never sees upstream responses (we fulfill them), so we must do
 * what it would: choose which jar cookies a request may carry, and validate Set-Cookie before storing.
 * Pure functions, no Playwright.
 */
import { isIP } from "node:net";
import { getDomain, getPublicSuffix } from "tldts";
import { normalizeHost } from "./policy.js";

export interface JarCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  expires?: number;
}

export type FetchSite = "same-origin" | "same-site" | "cross-site" | "none";

/**
 * Is `d` a public suffix (or a single label)? Cookies may not be scoped to one. Uses the bundled Public Suffix List
 * (tldts, ICANN + private sections, so github.io / ts.net / vercel.app count too) plus a "no single label" rule.
 */
export function isPublicSuffix(d: string): boolean {
  const dom = normalizeHost(d).replace(/^\./, "");
  if (!dom || !dom.includes(".")) return true;
  const registrable = getDomain(dom, { allowPrivateDomains: true });
  return registrable === null;
}

/** Registrable domain (eTLD+1) of a host; an IP or single label is its own site. */
export function siteOf(host: string): string {
  const h = normalizeHost(host);
  if (isIP(h) || h.includes(":") || !h.includes(".")) return h;
  return getDomain(h, { allowPrivateDomains: true }) ?? h;
}

/** Most restrictive of several relationships (an ancestor frame that is cross-site makes the request cross-site). */
export function worstSite(sites: readonly FetchSite[]): FetchSite {
  for (const w of ["cross-site", "same-site", "same-origin", "none"] as const) if (sites.includes(w)) return w;
  return "cross-site";
}

const originOf = (u: URL) => `${u.protocol}//${u.host}`;

/** Relationship between the request and the page that caused it (the Sec-Fetch-Site value). */
export function fetchSite(requestUrl: string, initiatorUrl: string | undefined, topLevelNavigation: boolean): FetchSite {
  if (topLevelNavigation && !initiatorUrl) return "none";
  let r: URL;
  let i: URL;
  try {
    r = new URL(requestUrl);
    i = new URL(initiatorUrl ?? "");
  } catch {
    return topLevelNavigation ? "none" : "cross-site";
  }
  if (originOf(r) === originOf(i)) return "same-origin";
  return siteOf(r.hostname) === siteOf(i.hostname) ? "same-site" : "cross-site";
}

export interface SelectContext {
  requestUrl: string;
  /** Sec-Fetch-Site as the browser sent it, else computed with fetchSite(). */
  site: FetchSite;
  method: string;
  /** Main-frame navigation (not a subframe, not a subresource). */
  topLevelNavigation: boolean;
  now?: number;
}

function domainMatches(host: string, cookieDomain: string): boolean {
  const d = normalizeHost(cookieDomain);
  if (cookieDomain.startsWith(".")) {
    const bare = d.replace(/^\./, "");
    return host === bare || host.endsWith("." + bare);
  }
  return host === d;
}

function pathMatches(reqPath: string, cookiePath: string): boolean {
  if (reqPath === cookiePath) return true;
  if (!reqPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || reqPath[cookiePath.length] === "/";
}

/**
 * Which jar cookies may this request carry? Mirrors the browser's own SameSite and third-party rules, conservatively:
 *  - same-origin, same-site and user-typed ("none") requests: everything domain/path/secure/expiry allow;
 *  - cross-site top-level navigation: never SameSite=Strict; Lax only on GET/HEAD; None always;
 *  - cross-site non-navigation (third-party subresources, fetch/XHR, iframes): no cookies at all.
 * Playwright does not expose `credentials: "omit"`, so cross-site non-navigation requests default to no cookies.
 */
export function selectCookies(jar: readonly JarCookie[], ctx: SelectContext): JarCookie[] {
  const u = new URL(ctx.requestUrl);
  const host = normalizeHost(u.hostname);
  const now = (ctx.now ?? Date.now()) / 1000;
  const getNav = ctx.topLevelNavigation && ["GET", "HEAD"].includes(ctx.method.toUpperCase());
  if (ctx.site === "cross-site" && !ctx.topLevelNavigation) return [];
  return jar.filter((c) => {
    if (c.expires !== undefined && c.expires > 0 && c.expires < now) return false;
    if (c.secure && u.protocol !== "https:") return false;
    if (!domainMatches(host, c.domain) || !pathMatches(u.pathname || "/", c.path || "/")) return false;
    // same-origin, same-site and user-typed requests carry Strict and Lax cookies too (www.x.com -> api.x.com logins).
    if (ctx.site !== "cross-site") return true;
    // cross-site (top-level navigation only, see above): Strict never, Lax on GET navigations, None always
    const ss = c.sameSite ?? "Lax";
    if (ss === "Strict") return false;
    if (ss === "Lax") return getNav;
    return true;
  });
}

export interface ParsedCookie {
  name: string;
  value: string;
  /** Set only for a Domain= attribute; stored as ".domain". */
  domain?: string;
  /** Always set (default path derived from the request). */
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  expires?: number;
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\./.test(host);
}

/** RFC 6265 5.1.4 default-path. */
export function defaultPath(requestPath: string): string {
  if (!requestPath || !requestPath.startsWith("/")) return "/";
  const i = requestPath.lastIndexOf("/");
  return i <= 0 ? "/" : requestPath.slice(0, i);
}

/** Parse and validate one Set-Cookie header for a response from `requestUrl`; undefined = reject. */
export function parseSetCookie(header: string, requestUrl: string, now = Date.now()): ParsedCookie | undefined {
  let u: URL;
  try {
    u = new URL(requestUrl);
  } catch {
    return undefined;
  }
  const host = normalizeHost(u.hostname);
  const parts = header.split(";");
  const pair = parts[0].trim();
  const eq = pair.indexOf("=");
  if (eq < 1) return undefined;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (!name || /[\s\x00-\x1f\x7f]/.test(name)) return undefined;

  const out: ParsedCookie = { name, value, path: defaultPath(u.pathname), secure: false, httpOnly: false };
  let domainAttr: string | undefined;
  let maxAge: number | undefined;
  let expires: number | undefined;
  let pathAttr: string | undefined;
  for (const raw of parts.slice(1)) {
    const a = raw.trim();
    if (!a) continue;
    const j = a.indexOf("="); // split on the FIRST "=" only: values may contain "="
    const key = (j < 0 ? a : a.slice(0, j)).trim().toLowerCase();
    const val = j < 0 ? "" : a.slice(j + 1).trim();
    if (key === "domain") domainAttr = val;
    else if (key === "path") pathAttr = val;
    else if (key === "secure") out.secure = true;
    else if (key === "httponly") out.httpOnly = true;
    else if (key === "max-age" && /^-?\d+$/.test(val)) maxAge = Number(val);
    else if (key === "expires") {
      const t = Date.parse(val);
      if (!Number.isNaN(t)) expires = Math.floor(t / 1000);
    } else if (key === "samesite" && /^(strict|lax|none)$/i.test(val)) {
      out.sameSite = (val[0].toUpperCase() + val.slice(1).toLowerCase()) as "Strict" | "Lax" | "None";
    }
  }
  if (pathAttr && pathAttr.startsWith("/")) out.path = pathAttr;
  if (maxAge !== undefined) out.expires = Math.floor(now / 1000) + maxAge;
  else if (expires !== undefined) out.expires = expires;

  if (domainAttr !== undefined) {
    const d = normalizeHost(domainAttr.replace(/^\./, ""));
    if (!d || !(host === d || host.endsWith("." + d))) return undefined; // must domain-match the request host
    if (isIP(host) || host.includes(":") ? d !== host : isPublicSuffix(d)) return undefined; // no dotless / public-suffix / foreign-IP scoping
    out.domain = "." + d;
  }
  if (out.sameSite === "None" && !out.secure) return undefined;
  // A Secure cookie may not be set over plain http (loopback excepted, as browsers treat it as a secure context).
  if (out.secure && u.protocol !== "https:" && !isLoopback(host)) return undefined;
  if (/^__secure-/i.test(name) && !(out.secure && u.protocol === "https:")) return undefined;
  if (/^__host-/i.test(name) && !(out.secure && u.protocol === "https:" && out.domain === undefined && out.path === "/")) return undefined;
  return out;
}
