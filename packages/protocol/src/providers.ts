/**
 * The provider list: what each AI provider can do, how its keys look and how to check one.
 * Shared by workerd, the console and the harness: no node imports; fetch is injected.
 * Never log or return key values.
 * `KeyChecker.check` calls the providers and runs on machines only (workerd, in Node).
 * Never call it from a browser; the console uses `checkKeyShape`, which makes no network call.
 */
export const CAPABILITIES = ["chat", "dictation", "memory"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Derived from PROVIDERS below: adding a provider is a single edit there (plus its probe). */
export type ProviderId = (typeof PROVIDERS)[number]["id"];
export type SlotId = (typeof PROVIDERS)[number]["slots"][number]["id"];

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>;

export type CheckResult =
  | { ok: true }
  | { ok: false; kind: "rejected" | "network" | "unexpected"; reason: string };

/** Plain data, so the console can receive it as JSON. */
export interface KeyShape {
  prefix?: string;
  /** RegExp source the whole key must match, e.g. "^[A-Za-z0-9]+$". */
  pattern?: string;
  minLength: number;
  maxLength: number;
  /** Shown to the user when the shape is wrong. */
  hint: string;
}

export interface ProviderDef {
  id: string;
  name: string;
  capabilities: readonly Capability[];
  /** Key slots: what the key file and key.set address. */
  slots: readonly { id: string; label: string }[];
  /** The page where the user gets a key. */
  keyUrl: string;
  shape: KeyShape;
}

export function maskKey(value: string): string {
  if (value.length < 12) return "•".repeat(value.length);
  return "••••" + value.slice(-4);
}

export const PROVIDERS = [
  {
    id: "anthropic",
    name: "Anthropic",
    capabilities: ["chat", "memory"],
    slots: [{ id: "anthropic", label: "Anthropic" }],
    keyUrl: "https://console.anthropic.com/settings/keys",
    shape: { prefix: "sk-ant-", minLength: 30, maxLength: 300, hint: "Anthropic keys start with sk-ant-" },
  },
  {
    id: "deepgram",
    name: "Deepgram",
    capabilities: ["dictation"],
    slots: [{ id: "deepgram", label: "Deepgram" }],
    keyUrl: "https://console.deepgram.com/",
    shape: { pattern: "^[A-Za-z0-9]+$", minLength: 32, maxLength: 64, hint: "Deepgram keys are 32 to 64 letters and digits" },
  },
] as const satisfies readonly ProviderDef[];

type Provider = (typeof PROVIDERS)[number];

// Compile every pattern once at load: a bad pattern fails here, not on a user's first key.
const PATTERNS = new Map<string, RegExp>(
  PROVIDERS.flatMap((p) => {
    const pattern = (p.shape as KeyShape).pattern;
    return pattern ? [[p.id, new RegExp(pattern)] as [string, RegExp]] : [];
  }),
);

export function providersByCapability(c: Capability): Provider[] {
  return PROVIDERS.filter((p) => (p.capabilities as readonly Capability[]).includes(c));
}

export function providerForSlot(slot: string): Provider | undefined {
  return PROVIDERS.find((p) => p.slots.some((s) => s.id === slot));
}

/**
 * The key as stored and sent: surrounding whitespace removed.
 * The caller stores this normalized value, never the raw input.
 */
export function normalizeKey(value: string): string {
  return value.trim();
}

/** Local shape check: no network. Normalizes first, so the browser and the machine agree. */
export function checkKeyShape(slot: string, value: string): { ok: true } | { ok: false; reason: string } {
  const p = providerForSlot(slot);
  if (!p) return { ok: false, reason: "unknown key slot" };
  const key = normalizeKey(value);
  // Whitespace, control characters and non-ASCII never belong in a key.
  if (/[^\x21-\x7e]/.test(key)) return { ok: false, reason: "key contains spaces or non-ASCII characters" };
  const s: KeyShape = p.shape;
  if (s.prefix && !key.startsWith(s.prefix)) return { ok: false, reason: s.hint };
  const re = PATTERNS.get(p.id);
  if (re && !re.test(key)) return { ok: false, reason: s.hint };
  if (key.length < s.minLength || key.length > s.maxLength) return { ok: false, reason: s.hint };
  return { ok: true };
}

const MAX_REASON = 300;
const DEFAULT_TIMEOUT_MS = 10_000;

interface Probe {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  messageOf(body: unknown): unknown;
  /** Reason for a 403, when it means more than "bad key". */
  forbidden?: string;
}

function probeFor(id: ProviderId, key: string): Probe {
  switch (id) {
    case "anthropic":
      return {
        url: "https://api.anthropic.com/v1/models?limit=1",
        method: "GET",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
        messageOf: (b: any) => b?.error?.message,
      };
    case "deepgram":
      // Proves the key can mint a dictation token, as the console dictation route does.
      // ttl 30: the grant is short-lived, so it does no harm. The token itself is never read.
      return {
        url: "https://api.deepgram.com/v1/auth/grant",
        method: "POST",
        headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl_seconds: 30 }),
        messageOf: (b: any) => b?.err_msg,
        // A 403 can mean a valid key without grant scope. Dictation needs the grant, so "rejected" is right.
        forbidden: "key rejected (HTTP 403): it may be valid but lack permission to create dictation tokens",
      };
  }
}

function redact(text: string, key: string): string {
  return key ? text.split(key).join("[key]") : text;
}

function clean(text: unknown, key: string): string | undefined {
  if (typeof text !== "string" || !text) return undefined;
  const out = redact(text, key);
  return out.length > MAX_REASON ? out.slice(0, MAX_REASON) : out;
}

/** `dispose` removes the fallback's abort listeners once the check is over. */
function combine(signals: AbortSignal[]): { signal: AbortSignal; dispose: () => void } {
  const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (any) return { signal: any.call(AbortSignal, signals), dispose: () => {} };
  const ac = new AbortController();
  const listeners: [AbortSignal, () => void][] = [];
  const dispose = () => { for (const [s, l] of listeners) s.removeEventListener("abort", l); };
  for (const s of signals) {
    if (s.aborted) { ac.abort(s.reason); break; }
    const l = () => ac.abort(s.reason);
    s.addEventListener("abort", l, { once: true });
    listeners.push([s, l]);
  }
  return { signal: ac.signal, dispose };
}

export class KeyChecker {
  constructor(private readonly deps: { fetch: FetchLike; timeoutMs?: number }) {}

  /**
   * Throws on an unknown slot (a programming error). Never returns or throws the key.
   * Checks the normalized key (`normalizeKey`); the caller stores that same normalized value.
   * Partial-key echo in a provider message is an accepted risk (redaction matches the whole key).
   */
  async check(slot: string, value: string, opts?: { signal?: AbortSignal }): Promise<CheckResult> {
    const p = providerForSlot(slot);
    if (!p) throw new Error(`unknown key slot: ${slot}`);
    const key = normalizeKey(value);
    const shape = checkKeyShape(slot, key);
    if (!shape.ok) return { ok: false, kind: "rejected", reason: shape.reason };

    const probe = probeFor(p.id, key);
    const timeout = AbortSignal.timeout(this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const { signal, dispose } = combine(opts?.signal ? [timeout, opts.signal] : [timeout]);
    let res: Response;
    try {
      res = await this.deps.fetch(probe.url, { method: probe.method, headers: probe.headers, body: probe.body, signal });
    } catch (e) {
      dispose();
      if (timeout.aborted) return { ok: false, kind: "network", reason: "timed out" };
      if (opts?.signal?.aborted) return { ok: false, kind: "network", reason: "cancelled" };
      return { ok: false, kind: "network", reason: clean(e instanceof Error ? e.message : undefined, key) ?? "network error" };
    }
    dispose();
    if (res.ok) {
      await res.body?.cancel().catch(() => {});
      return { ok: true };
    }
    const code = res.status;
    if (code === 401 || code === 403) {
      let msg: string | undefined;
      try { msg = clean(probe.messageOf(await res.json()), key); } catch { /* body not JSON */ }
      await res.body?.cancel().catch(() => {});
      const reason = code === 403 && probe.forbidden ? probe.forbidden : msg ?? `rejected (HTTP ${code})`;
      return { ok: false, kind: "rejected", reason };
    }
    await res.body?.cancel().catch(() => {});
    if (code === 429 || code >= 500) return { ok: false, kind: "network", reason: `provider unavailable (HTTP ${code})` };
    return { ok: false, kind: "unexpected", reason: `unexpected response (HTTP ${code})` };
  }
}
