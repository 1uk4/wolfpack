/**
 * The console's side of the pack inventory (work-wolfpack-ZproKxi): one read of the hub's GET /v1/inventory (every service on every machine
 * and the release it runs) with the VIEWER's own bearer. The console holds no hub credential of its own for this and keeps no copy: the
 * unauthenticated /api/health snapshot carries no inventory. Each machine's workerd reports its local console, so the console no longer
 * heartbeats. `behind` is judged against the manifest of the channel the service itself reported; a service with no channel or a `-dev`
 * version gets no verdict. The whole read (hub fetch and manifest lookups) shares one deadline; a manifest that is late means `latest: null`.
 */
import type { InventoryListed, ManifestResult } from "@wolfpack/protocol";
import { isNewerVersion } from "../../core/pack/pack-health-view.ts";

/** How a read of the hub inventory ended: rows, no sign-in (no bearer or the hub said 401/403), or unavailable (anything else). */
export type InventoryRead = { state: "ok"; rows: RemoteService[]; hubMachine: string | null } | { state: "signed-out" } | { state: "unavailable" };

/** One inventory row as the panel gets it. `latest`: the channel's newer version when this row is behind, else null. */
export interface RemoteService extends InventoryListed {
	latest: string | null;
}

export interface ReadInventoryOptions {
	hubUrl: string | undefined;
	/** The caller's bearer (the viewer's sign-in). Undefined: signed-out, no request is made. */
	token: string | undefined;
	manifest: (channel: "stable" | "main") => Promise<ManifestResult>;
	fetch?: typeof fetch;
	timeoutMs?: number;
}

/** The newer version the channel's manifest offers for this row, or null (no channel, a dev build, up to date, no manifest, or the deadline passed). */
async function latestFor(e: InventoryListed, cache: Map<string, Promise<ManifestResult | null>>, o: ReadInventoryOptions, expired: Promise<null>): Promise<string | null> {
	if (!e.channel || !e.version || /-dev(?:[.+]|$)/.test(e.version)) return null;
	let p = cache.get(e.channel);
	if (!p) {
		p = Promise.race([o.manifest(e.channel).catch((): ManifestResult => ({ manifest: null, error: "manifest" })), expired]);
		cache.set(e.channel, p);
	}
	const m = await p;
	const target = m?.manifest?.components?.[e.kind]?.version;
	return target && isNewerVersion(target, e.version) ? target : null;
}

/** One read of the hub's GET /v1/inventory with the given bearer (2 s deadline by default). Never throws. */
export async function readInventory(o: ReadInventoryOptions): Promise<InventoryRead> {
	if (!o.token) return { state: "signed-out" };
	if (!o.hubUrl) return { state: "unavailable" };
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? 2000); // a ref'd timer: AbortSignal.timeout's is unref'd and cannot be relied on to fire
	const expired = new Promise<null>((res) => ac.signal.addEventListener("abort", () => res(null), { once: true }));
	try {
		const r = await (o.fetch ?? fetch)(`${o.hubUrl}/v1/inventory`, { headers: { Authorization: `Bearer ${o.token}` }, signal: ac.signal });
		if (r.status === 401 || r.status === 403) return { state: "signed-out" };
		if (!r.ok) return { state: "unavailable" };
		const body = (await r.json()) as { entries?: InventoryListed[]; hubMachine?: string };
		if (!Array.isArray(body.entries)) return { state: "unavailable" };
		const cache = new Map<string, Promise<ManifestResult | null>>();
		const rows: RemoteService[] = [];
		for (const e of body.entries) rows.push({ ...e, latest: await latestFor(e, cache, o, expired) });
		return { state: "ok", rows, hubMachine: typeof body.hubMachine === "string" ? body.hubMachine : null };
	} catch {
		return { state: "unavailable" };
	} finally {
		clearTimeout(timer);
	}
}
