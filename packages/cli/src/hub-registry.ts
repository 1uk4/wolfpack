/**
 * Domain registration on the hub (hubd). When WOLFPACK_HUB_URL is set the hub owns the KB tree, so `domain add|rm` call
 * `/v1/registry/domains` instead of writing a domain folder or domains.yaml (a worker's KB path is a read-only hub mirror).
 */
export interface HubTarget {
  baseUrl: string;
  token?: string;
  fetch?: typeof fetch;
}

/** A non-2xx answer from the hub. */
export class HubHttpError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

/** The hub configured in `env` (WOLFPACK_HUB_URL / WOLFPACK_HUB_TOKEN, same knobs as packages/memory crawl/hub.ts), or undefined. */
export function hubFromEnv(env: Record<string, string | undefined> = process.env): HubTarget | undefined {
  const baseUrl = env.WOLFPACK_HUB_URL?.trim();
  return baseUrl ? { baseUrl: baseUrl.replace(/\/+$/, ""), token: env.WOLFPACK_HUB_TOKEN?.trim() || undefined } : undefined;
}

/** Remove URL credentials, the base URL's userinfo and the token from any text shown to the user. */
export function scrubHub(hub: HubTarget, text: string): string {
  let out = text.replace(/(\/\/)[^/@\s]*@/g, "$1");
  if (hub.token) out = out.split(hub.token).join("***");
  return out;
}

async function call(hub: HubTarget, method: string, path: string, body?: unknown): Promise<void> {
  let res: Response;
  try {
    res = await (hub.fetch ?? fetch)(`${hub.baseUrl}${path}`, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(hub.token ? { Authorization: `Bearer ${hub.token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new Error(scrubHub(hub, `hub ${method} ${path} failed (${e instanceof Error ? e.message : String(e)})`));
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    let code: string | undefined;
    try {
      const j = (await res.json()) as { error?: unknown; code?: unknown; message?: unknown };
      if (j.error || j.message) msg += `: ${String(j.error ?? j.message)}`;
      code = [j.code, j.error].find((x) => x === "not_found") as string | undefined;
    } catch { /* no body */ }
    throw new HubHttpError(res.status, scrubHub(hub, `hub ${method} ${path} failed (${msg})`), code);
  }
}

/** Register a domain; hubd answers 409 for one that already exists, which is reported as "exists" (not an error). */
export async function registerDomainOnHub(hub: HubTarget, d: { name: string; label?: string; description?: string; created?: string }): Promise<"created" | "exists"> {
  try {
    await call(hub, "POST", "/v1/registry/domains", d);
    return "created";
  } catch (e) {
    if (e instanceof HubHttpError && e.status === 409) return "exists";
    throw e;
  }
}

/** Remove a domain; hubd answers 404 for an unknown one, reported as "absent" (not an error). */
export async function removeDomainOnHub(hub: HubTarget, name: string): Promise<"removed" | "absent"> {
  try {
    await call(hub, "DELETE", `/v1/registry/domains/${encodeURIComponent(name)}`);
    return "removed";
  } catch (e) {
    if (e instanceof HubHttpError && e.status === 404 && e.code === "not_found") return "absent";
    throw e;
  }
}

/** The hub URL without credentials, query or fragment (safe to print). */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = ""; u.password = ""; u.search = ""; u.hash = "";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return url.replace(/\/\/[^/@\s]*@/g, "//").replace(/\/+$/, "");
  }
}

/** The hub's label/description for a domain (best effort: undefined on any failure). */
export async function getDomainOnHub(hub: HubTarget, name: string): Promise<{ label?: string; description?: string } | undefined> {
  try {
    const res = await (hub.fetch ?? fetch)(`${hub.baseUrl}/v1/registry/domains/${encodeURIComponent(name)}`, {
      headers: hub.token ? { Authorization: `Bearer ${hub.token}` } : {},
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return undefined;
    const j = (await res.json()) as { domain?: { label?: string; description?: string } };
    return j.domain;
  } catch {
    return undefined;
  }
}
