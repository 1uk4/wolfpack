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
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** The hub configured in `env` (WOLFPACK_HUB_URL / WOLFPACK_HUB_TOKEN, same knobs as packages/memory crawl/hub.ts), or undefined. */
export function hubFromEnv(env: Record<string, string | undefined> = process.env): HubTarget | undefined {
  const baseUrl = env.WOLFPACK_HUB_URL?.trim();
  return baseUrl ? { baseUrl: baseUrl.replace(/\/+$/, ""), token: env.WOLFPACK_HUB_TOKEN?.trim() || undefined } : undefined;
}

async function call(hub: HubTarget, method: string, path: string, body?: unknown): Promise<void> {
  const res = await (hub.fetch ?? fetch)(`${hub.baseUrl}${path}`, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(hub.token ? { Authorization: `Bearer ${hub.token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = (await res.json()) as { error?: unknown }; if (j.error) msg += `: ${String(j.error)}`; } catch { /* no body */ }
    throw new HubHttpError(res.status, `hub ${method} ${path} failed (${msg})`);
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
    if (e instanceof HubHttpError && e.status === 404) return "absent";
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
