/**
 * Pure guards for the browser extension: URL policy, header redaction, output caps.
 * No Playwright and no I/O here, so they are unit-testable and safe to import anywhere.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// ─── URL policy ────────────────────────────────────────────────────────────

export interface UrlVerdict {
  ok: boolean;
  /** Why the URL is blocked (absent when ok). */
  reason?: string;
}

export interface UrlPolicyOptions {
  /** Hosts allowed even when private: exact host/IP, or `*.example.com` for a suffix. */
  allowHosts?: readonly string[];
  /** The request is a top-level/frame navigation (data:/blob: are only tolerated for subresources). */
  navigation?: boolean;
  /** The URL is a WebSocket endpoint: ws:/wss: are accepted and judged like http:/https:. */
  websocket?: boolean;
}

/** Normalise a host: lowercase, no brackets, no trailing dot. */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  while (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

function ipv4Parts(h: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return undefined;
  const p = m.slice(1).map(Number);
  return p.every((n) => n <= 255) ? p : undefined;
}

/** Why an IPv4 address is private, or undefined when public. */
function privateV4(p: number[]): string | undefined {
  const [a, b] = p;
  if (a === 127) return "loopback address";
  if (a === 0) return "unspecified address";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private (RFC1918) address";
  if (a === 169 && b === 254) return "link-local address";
  if (a === 100 && b >= 64 && b <= 127) return "tailnet / CGNAT (100.64.0.0/10) address";
  if (a === 192 && b === 0 && p[2] === 0) return "IETF reserved (192.0.0.0/24) address";
  if (a === 198 && (b === 18 || b === 19)) return "benchmarking (198.18.0.0/15) address";
  if (a >= 224) return "multicast / reserved / broadcast address";
  return undefined;
}

/** Expand an IPv6 literal into 8 16-bit groups (handles `::` and a trailing dotted v4). */
function ipv6Groups(h: string): number[] | undefined {
  let s = h.split("%")[0];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const v4 = ipv4Parts(dotted[1]);
    if (!v4) return undefined;
    s = s.slice(0, -dotted[1].length) + ((v4[0] << 8) | v4[1]).toString(16) + ":" + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return undefined;
  const all = [...head, ...Array(fill).fill("0"), ...tail].map((g) => parseInt(g, 16));
  return all.length === 8 && all.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? all : undefined;
}

function privateV6(h: string): string | undefined {
  const g = ipv6Groups(h);
  if (!g) return "unparseable IPv6 address";
  if (g.every((x) => x === 0)) return "unspecified address";
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback address";
  if ((g[0] & 0xfe00) === 0xfc00) return "unique-local IPv6 address";
  if ((g[0] & 0xffc0) === 0xfe80) return "link-local address";
  if ((g[0] & 0xffc0) === 0xfec0) return "site-local (fec0::/10) address";
  if ((g[0] & 0xff00) === 0xff00) return "multicast address";
  // NAT64 64:ff9b::/96 embeds an IPv4 address; 64:ff9b:1::/48 is local-use NAT64
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    if (g[2] === 1) return "local-use NAT64 (64:ff9b:1::/48) address";
    if (g.slice(2, 6).every((x) => x === 0)) return privateV4([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255]) && "NAT64 address embedding an internal IPv4";
  }
  // 6to4 2002::/16 embeds the IPv4 in groups 1-2
  if (g[0] === 0x2002) return privateV4([g[1] >> 8, g[1] & 255, g[2] >> 8, g[2] & 255]) && "6to4 address embedding an internal IPv4";
  if (g[0] === 0x2001 && g[1] === 0) return "Teredo (2001::/32) address";
  // IPv4-mapped (::ffff:a.b.c.d) and deprecated IPv4-compatible (::a.b.c.d)
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    return privateV4([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255]);
  }
  return undefined;
}

/** Why a bare host (name or IP literal) is internal, or undefined when it looks public. */
export function privateHostReason(rawHost: string): string | undefined {
  const host = normalizeHost(rawHost);
  if (!host) return "empty host";
  if (host === "localhost" || host.endsWith(".localhost")) return "localhost";
  if (host.endsWith(".ts.net")) return "tailnet (*.ts.net) host";
  if (host.endsWith(".local") || host.endsWith(".internal")) return "internal host name";
  const v4 = ipv4Parts(host);
  if (v4) return privateV4(v4);
  if (isIP(host) === 6 || host.includes(":")) return privateV6(host);
  return undefined;
}

/** Does `host` match an allowlist entry (exact, or `*.suffix`)? */
export function hostAllowed(rawHost: string, allow: readonly string[] | undefined): boolean {
  const host = normalizeHost(rawHost);
  for (const entry of allow ?? []) {
    const e = normalizeHost(entry);
    if (!e) continue;
    if (e.startsWith("*.") ? host.endsWith(e.slice(1)) : host === e) return true;
  }
  return false;
}

/** Synchronous URL policy (no DNS). */
export function checkUrl(raw: string, opts: UrlPolicyOptions = {}): UrlVerdict {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid absolute URL" };
  }
  if (u.protocol === "about:") {
    return raw.trim().toLowerCase() === "about:blank" ? { ok: true } : { ok: false, reason: "only about:blank is allowed" };
  }
  if ((u.protocol === "data:" || u.protocol === "blob:") && opts.navigation === false) return { ok: true };
  const web = u.protocol === "http:" || u.protocol === "https:" || (opts.websocket === true && (u.protocol === "ws:" || u.protocol === "wss:"));
  if (!web) return { ok: false, reason: `scheme ${u.protocol} is blocked (http/https only)` };
  if (hostAllowed(u.hostname, opts.allowHosts)) return { ok: true };
  const why = privateHostReason(u.hostname);
  return why ? { ok: false, reason: `${normalizeHost(u.hostname)} is a ${why}; add it to browser.allowHosts to permit it` } : { ok: true };
}

export type Resolver = (host: string) => Promise<string[]>;

const systemResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** Why the addresses a name resolved to are unacceptable, or undefined when all are public. */
function addressVerdict(host: string, addrs: readonly string[]): string | undefined {
  if (addrs.length === 0) return `${host} did not resolve to any address`;
  for (const a of addrs) {
    const why = privateHostReason(a);
    if (why) return `${host} resolves to ${normalizeHost(a)}, a ${why}; add it to browser.allowHosts to permit it`;
  }
  return undefined;
}

/**
 * URL policy plus DNS (an early, friendly check; NOT the enforcement point: see guardedLookup). A public-looking name
 * that resolves to an internal address is blocked unless the name is allowlisted. A resolver error FAILS CLOSED.
 */
export async function checkUrlResolved(raw: string, opts: UrlPolicyOptions = {}, resolve: Resolver = systemResolver): Promise<UrlVerdict> {
  const v = checkUrl(raw, opts);
  if (!v.ok) return v;
  const u = new URL(raw);
  if (u.protocol === "about:" || u.protocol === "data:" || u.protocol === "blob:") return v;
  const host = normalizeHost(u.hostname);
  if (hostAllowed(host, opts.allowHosts) || isIP(host) || host.includes(":")) return v;
  let addrs: string[];
  try {
    addrs = await resolve(host);
  } catch (err) {
    return { ok: false, reason: `could not resolve ${host} (${err instanceof Error ? err.message : String(err)}); blocked (fail closed)` };
  }
  const why = addressVerdict(host, addrs);
  return why ? { ok: false, reason: why } : v;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address?: string | { address: string; family: number }[], family?: number) => void;

/**
 * A `lookup` for http(s).request / net.connect that enforces the policy on the address actually connected to: the
 * addresses it returns are the only ones the socket can use, so DNS rebinding between check and connect cannot happen.
 * Allowlisted hosts skip the check. Resolver errors and empty answers reject (fail closed).
 */
export function guardedLookup(allowHosts: readonly string[] | undefined, resolve: Resolver = systemResolver) {
  return (hostname: string, options: unknown, cb?: LookupCb): void => {
    const callback = (typeof options === "function" ? options : cb) as LookupCb;
    const opts = (typeof options === "object" && options ? options : {}) as { all?: boolean; family?: number };
    const host = normalizeHost(hostname);
    resolve(host).then(
      (addrs) => {
        const why = hostAllowed(host, allowHosts) ? undefined : addressVerdict(host, addrs);
        if (why) return callback(Object.assign(new Error(`blocked: ${why}`), { code: "EACCES" }));
        const list = addrs
          .map((address) => ({ address, family: isIP(address) }))
          .filter((a) => a.family && (!opts.family || opts.family === 0 || a.family === opts.family));
        if (list.length === 0) return callback(Object.assign(new Error(`blocked: ${host} has no usable address`), { code: "ENOTFOUND" }));
        if (opts.all) return callback(null, list);
        callback(null, list[0].address, list[0].family);
      },
      (err) => callback(Object.assign(new Error(`blocked: could not resolve ${host} (${err instanceof Error ? err.message : String(err)})`), { code: "EACCES" })),
    );
  };
}

// ─── Header redaction ──────────────────────────────────────────────────────

export const REDACTED = "[redacted]";

const SENSITIVE_HEADER = /auth|token|cookie|secret|api-?key|session|csrf/i;
const SENSITIVE_QUERY = /token|key|secret|auth|sig|session|code|password/i;

/** Copy headers with the values of credential-bearing ones replaced. Names stay (so the model sees they were sent). */
export function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) out[k] = SENSITIVE_HEADER.test(k) ? REDACTED : v;
  return out;
}

/** Make a URL safe to show: no userinfo, no fragment, credential-looking query values masked. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.protocol === "data:" || u.protocol === "blob:") return `${u.protocol}…`;
    u.hash = "";
    const hadUser = u.username || u.password;
    u.username = "";
    u.password = "";
    for (const k of [...new Set(u.searchParams.keys())]) {
      if (SENSITIVE_QUERY.test(k)) u.searchParams.set(k, "REDACTED");
    }
    const out = u.toString();
    return hadUser ? out.replace("://", `://${REDACTED}@`) : out;
  } catch {
    return raw.split("#")[0].replace(/([?&][^=&]*(?:token|key|secret|auth|sig|session|code|password)[^=&]*=)[^&]*/gi, "$1REDACTED");
  }
}

// ─── Output caps ───────────────────────────────────────────────────────────

/** Truncate text to `max` characters with an explicit marker. */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} of ${text.length} characters]`;
}

/** Keep the newest `limit` entries (clamped to 1..cap). */
export function lastN<T>(items: readonly T[], limit: number | undefined, cap: number): T[] {
  const asked = Math.floor(limit ?? 50);
  const n = Math.min(asked >= 1 ? asked : 50, cap);
  return items.slice(-n);
}
