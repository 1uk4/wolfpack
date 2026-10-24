/**
 * The search engines' server composition (search port + model slots wave,
 * 2026-09-20): the Tavily + Brave adapters behind the core port
 * (core/search.ts) + the live-engine resolution the settings UI and the
 * agent-layer tool both read.
 *
 * Owner decisions (2026-09-20) baked in:
 *  - NO default engine: an engine is live iff its key is present (auth
 *    store or env — env wins, keyed via server/keys.ts keyValue).
 *  - Setting a key is ALL the user does — auto-detection: explicit
 *    agent.search.engine pins the preference (when BOTH keys are present
 *    the preference order is Tavily → Brave); without a pin, whichever
 *    engine has a key is the engine.
 *  - An explicit choice does NOT silently fall back to the other engine:
 *    engine pinned but its key missing = honestly unavailable (reason
 *    says so) — no guessing what the user meant.
 *
 * The adapters are injected dependencies (fetch-shaped) so the agent-layer
 * tool depends on the PORT only and tests never touch the network.
 */
import type { SearchEngineId, SearchProvider, SearchStatus } from "../core/search.ts";
/** The wire-callable shape the adapters close over (tests inject a stub). */
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
/** Tavily: POST https://api.tavily.com/search — Bearer auth in the
 *  Authorization header (the current documented scheme; the legacy
 *  api_key-in-body form is retired), query + max_results (0–20) in the
 *  JSON body. VERIFIED against docs.tavily.com's OpenAPI, 2026-09-20:
 *  response {results: [{title, url, content, score, …}]}, errors
 *  {detail: {error}}. */
export declare function tavilyProvider(apiKey: string, fetchFn?: FetchLike): SearchProvider;
/** Brave: GET https://api.search.brave.com/res/v1/web/search with the
 *  key in the X-Subscription-Token header. VERIFIED against Brave's
 *  dashboard docs, 2026-09-20: count max 20; response
 *  {web: {results: [{title, url, description, …}]}}. */
export declare function braveProvider(apiKey: string, fetchFn?: FetchLike): SearchProvider;
/** Resolve the search state PURELY from the given pins (testable): the
 *  explicit engine (if pinned) wins but must be keyed; absent pin → first
 *  keyed engine in preference order. Never throws. */
export declare function resolveSearchEngineFor(pinned: SearchEngineId | undefined, 
/** Per-engine live keys (absent engine = absent property is fine). */
keys: Partial<Record<SearchEngineId, string | undefined>>): SearchStatus & {
    key: string | null;
};
/** The live search state (the honest availability signal): reads the
 *  settings record's pin + the auth store fresh each call, so a key saved
 *  mid-session activates on the next check (no restart). */
export declare function searchStatus(): SearchStatus;
/** Search available at all? (the settings UI's gray-out signal + the
 *  researcher's enable/disable pin — Teacher stream's rewiring reads this.) */
export declare function searchAvailable(): boolean;
/** The LIVE adapter, or null when unavailable. Composed fresh each call —
 *  the tool layer (Teacher stream) calls this once per search, so key
 *  rotations take effect immediately. */
export declare function searchProvider(): SearchProvider | null;
export {};
//# sourceMappingURL=search.d.ts.map