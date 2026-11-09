/**
 * Update notices: the stable-release manifest (published by .github/workflows/release-stable.yml, built by scripts/stable-manifest.mjs),
 * a semver compare and a cached, time-limited fetch of the manifest. Pure (global fetch + timers only), like ./health.ts.
 */

/** One component's latest stable release. */
export interface ManifestEntry {
  /** X.Y.Z (no leading v). */
  version: string;
  /** The git tag, `<component>/vX.Y.Z`. */
  tag: string;
  /** Full commit sha the tag points at. */
  sha: string;
  /** ISO time the tag was created. */
  publishedAt: string;
  /** The GitHub Release page for the tag. */
  notesUrl: string;
}

export interface StableManifest {
  schema: 1;
  generatedAt: string;
  components: Record<string, ManifestEntry>;
}

/** Where release-stable.yml publishes the manifest: an asset on the fixed `stable-manifest` release (readable without auth on a public repo). */
export const DEFAULT_MANIFEST_URL = "https://github.com/1uk4/wolfpack/releases/download/stable-manifest/stable.json";
/** How long a fetched manifest is reused. Releases land a few times a week at most. */
export const MANIFEST_TTL_MS = 10 * 60_000;
/** A failed fetch is retried no sooner than this. */
export const MANIFEST_RETRY_MS = 60_000;
export const MANIFEST_TIMEOUT_MS = 5_000;

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z.-]+)?$/;

function parse(v: string): { core: number[]; pre: string[] } | null {
  const m = SEMVER.exec(v.trim());
  return m ? { core: [+m[1]!, +m[2]!, +m[3]!], pre: m[4] ? m[4].split(".") : [] } : null;
}

/** Semver 2.0 precedence of a vs b: -1, 0 or 1; null when either is not X.Y.Z[-pre][+build]. Build metadata is ignored, a leading v allowed. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  const sign = (n: number): -1 | 0 | 1 => (n < 0 ? -1 : n > 0 ? 1 : 0);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return sign(x.core[i]! - y.core[i]!);
  if (!x.pre.length || !y.pre.length) return sign(y.pre.length - x.pre.length); // a release outranks its prereleases
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return sign(Number(p) - Number(q));
    if (pn !== qn) return pn ? -1 : 1; // numeric identifiers rank below alphanumeric ones
    return p < q ? -1 : 1;
  }
  return 0;
}

export interface UpdateRow {
  component: string;
  /** What the component reports (a /healthz `version` or a VERSION file); null when unknown. */
  running: string | null;
  /** Latest stable version from the manifest; null when the component has no release. */
  latest: string | null;
  /** true = a newer stable release exists; null = cannot tell (unknown, unreadable or unpublished). */
  outdated: boolean | null;
  notesUrl: string | null;
}

/**
 * An unstamped build (`<package.json>-dev`, `-dev+<sha>`): its version says nothing about the release it came from.
 * Not semver at all (e.g. the old bare-sha VERSION files still on sfo-01) is not dev either: it fails `parse`, so `compareVersions`
 * gives null and the row is unknown (`outdated: null`), never prompted. Such a host gets no notice until it runs a stamped release.
 */
export function isDevVersion(v: string): boolean {
  return parse(v)?.pre.includes("dev") ?? false;
}

/** One row per key of `running`, in its order. A dev (unstamped) running version is never outdated: `outdated` is null. */
export function checkUpdates(manifest: StableManifest | null, running: Record<string, string | null | undefined>): UpdateRow[] {
  return Object.entries(running).map(([component, r]) => {
    const entry = manifest?.components[component];
    const cmp = r && entry && !isDevVersion(r) ? compareVersions(r, entry.version) : null;
    return { component, running: r ?? null, latest: entry?.version ?? null, outdated: cmp === null ? null : cmp < 0, notesUrl: entry?.notesUrl ?? null };
  });
}

function isManifest(x: unknown): x is StableManifest {
  if (!x || typeof x !== "object") return false;
  const c = (x as { components?: unknown }).components;
  if (!c || typeof c !== "object" || Array.isArray(c)) return false;
  return Object.values(c).every((e) => !!e && typeof e === "object" && typeof (e as ManifestEntry).version === "string" && typeof (e as ManifestEntry).notesUrl === "string");
}

export interface ManifestResult {
  manifest: StableManifest | null;
  /** Why there is no fresh manifest (the last good one may still be returned). */
  error?: string;
  /** When the returned manifest was fetched (ISO); undefined when none was ever fetched. */
  fetchedAt?: string;
}

export interface ManifestFetcherOptions {
  url?: string;
  timeoutMs?: number;
  ttlMs?: number;
  retryMs?: number;
  now?: () => number;
  fetch?: typeof fetch;
}

/**
 * A manifest reader: fetches at most once per `ttlMs` (a failure is retried after `retryMs`, keeping the last good manifest), concurrent
 * calls share one request, and a request is abandoned after `timeoutMs`. Never throws.
 */
export function createManifestFetcher(opts: ManifestFetcherOptions = {}): () => Promise<ManifestResult> {
  const url = opts.url ?? DEFAULT_MANIFEST_URL;
  const timeoutMs = opts.timeoutMs ?? MANIFEST_TIMEOUT_MS;
  const ttl = opts.ttlMs ?? MANIFEST_TTL_MS;
  const retry = opts.retryMs ?? MANIFEST_RETRY_MS;
  const now = opts.now ?? Date.now;
  let good: { manifest: StableManifest; at: number } | undefined;
  let last: { result: ManifestResult; at: number; ok: boolean } | undefined;
  let pending: Promise<ManifestResult> | undefined;

  const load = async (): Promise<ManifestResult> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await (opts.fetch ?? fetch)(url, { signal: ctl.signal, headers: { accept: "application/json" } });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body: unknown = JSON.parse(text);
      if (!isManifest(body)) throw new Error("not a stable manifest");
      good = { manifest: body, at: now() };
      return { manifest: body, fetchedAt: new Date(good.at).toISOString() };
    } catch (e) {
      const cause = (e as { cause?: { code?: string } }).cause?.code; // fetch's "fetch failed" hides the reason (ECONNREFUSED, ENOTFOUND) in cause
      const error = ctl.signal.aborted ? `no answer within ${timeoutMs}ms` : e instanceof SyntaxError ? "unparseable manifest" : (cause ?? (e instanceof Error ? e.message : String(e)));
      return good ? { manifest: good.manifest, error, fetchedAt: new Date(good.at).toISOString() } : { manifest: null, error };
    } finally {
      clearTimeout(timer);
    }
  };

  return () => {
    if (last && now() - last.at < (last.ok ? ttl : retry)) return Promise.resolve(last.result);
    pending ??= load()
      .then((result) => {
        last = { result, at: now(), ok: !result.error };
        return result;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}
