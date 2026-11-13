/**
 * The console's side of the pack inventory (work-wolfpack-ZproKxi): polls the hub's GET /v1/inventory (every service on every machine
 * and the release it runs). The console no longer reports itself: each machine's workerd probes its local console and reports it.
 * The Pack panel reads with the viewer's own bearer (readInventory); the env-token poll below is only an optional fallback. A hub without the routes (404) means
 * "no inventory": the panel then shows local probes and presence only. `behind` is judged against the manifest of the channel the
 * service itself reported; a service with no channel or a `-dev` version gets no verdict.
 */
import type { InventoryListed, ManifestResult } from "@wolfpack/protocol";
import { isNewerVersion } from "../../core/pack/pack-health-view.ts";

/** How a read of the hub inventory ended: rows, no sign-in (no bearer or the hub said 401/403), or unavailable (anything else). */
export type InventoryRead = { state: "ok"; rows: RemoteService[]; hubMachine: string | null } | { state: "signed-out" } | { state: "unavailable" };

export interface ReadInventoryOptions {
	hubUrl: string | undefined;
	/** The caller's bearer (the viewer's sign-in). Undefined: signed-out, no request is made. */
	token: string | undefined;
	manifest: (channel: "stable" | "main") => Promise<ManifestResult>;
	fetch?: typeof fetch;
	timeoutMs?: number;
}

/** The newer version the channel's manifest offers for this row, or null (no channel, a dev build, up to date, or no manifest). */
async function latestFor(e: InventoryListed, cache: Map<string, ManifestResult>, manifest: ReadInventoryOptions["manifest"]): Promise<string | null> {
	if (!e.channel || !e.version || /-dev(?:[.+]|$)/.test(e.version)) return null;
	let m = cache.get(e.channel);
	if (!m) {
		m = await manifest(e.channel).catch((): ManifestResult => ({ manifest: null, error: "manifest" }));
		cache.set(e.channel, m);
	}
	const target = m.manifest?.components?.[e.kind]?.version;
	return target && isNewerVersion(target, e.version) ? target : null;
}

/** One read of the hub's GET /v1/inventory with the given bearer (2 s timeout by default). Never throws. */
export async function readInventory(o: ReadInventoryOptions): Promise<InventoryRead> {
	if (!o.token) return { state: "signed-out" };
	if (!o.hubUrl) return { state: "unavailable" };
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? 2000); // a ref'd timer: AbortSignal.timeout's is unref'd and cannot be relied on to fire
	try {
		const r = await (o.fetch ?? fetch)(`${o.hubUrl}/v1/inventory`, { headers: { Authorization: `Bearer ${o.token}` }, signal: ac.signal });
		if (r.status === 401 || r.status === 403) return { state: "signed-out" };
		if (!r.ok) return { state: "unavailable" };
		const body = (await r.json()) as { entries?: InventoryListed[]; hubMachine?: string };
		if (!Array.isArray(body.entries)) return { state: "unavailable" };
		const cache = new Map<string, ManifestResult>();
		const rows: RemoteService[] = [];
		for (const e of body.entries) rows.push({ ...e, latest: await latestFor(e, cache, o.manifest) });
		return { state: "ok", rows, hubMachine: typeof body.hubMachine === "string" ? body.hubMachine : null };
	} catch {
		return { state: "unavailable" };
	} finally {
		clearTimeout(timer);
	}
}

/** One inventory row as the panel gets it. `latest`: the channel's newer version when this row is behind, else null. */
export interface RemoteService extends InventoryListed {
	latest: string | null;
}

export interface InventoryView {
	rows: RemoteService[];
	/** The hub did not answer the last poll; rows are the last good ones. */
	stale: boolean;
	hubMachine: string | null;
}

export interface InventoryClientOptions {
	/** The hub origin + path prefix, e.g. http://127.0.0.1:3150 (no trailing slash). Undefined: off. */
	hubUrl: string | undefined;
	/** The hub bearer token, read on every call. */
	token: () => string | undefined;
	manifest: (channel: "stable" | "main") => Promise<ManifestResult>;
	fetch?: typeof fetch;
	now?: () => number;
	timeoutMs?: number;
	/** How long the last result is kept after failures before it is dropped. */
	keepMs?: number;
}

export interface InventoryClient {
	view(): InventoryView | null;
	/** Fetch the inventory once. */
	poll(): Promise<void>;
	start(): void;
	stop(): void;
}

const BACKOFF_MS = 5 * 60_000;
const isDev = (v: string) => /-dev(?:[.+]|$)/.test(v);

export function createInventoryClient(o: InventoryClientOptions): InventoryClient {
	const doFetch = o.fetch ?? fetch;
	const now = o.now ?? Date.now;
	const timeoutMs = o.timeoutMs ?? 3000;
	const keepMs = o.keepMs ?? 60_000;
	let last: { at: number; rows: RemoteService[]; hubMachine: string | null } | null = null;
	let stale = false;
	let none = false; // the hub answered 404: it has no inventory
	let pollPausedUntil = 0;
	const timers: ReturnType<typeof setInterval>[] = [];

	const req = async (path: string, init: RequestInit = {}): Promise<Response | undefined> => {
		const token = o.token();
		if (!o.hubUrl || !token) return undefined;
		try {
			return await doFetch(`${o.hubUrl}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
		} catch {
			return undefined;
		}
	};

	/** The newer version the channel's manifest offers for this row, or null (no channel, a dev build, up to date, or no manifest). */
	const latestFor = async (e: InventoryListed, cache: Map<string, ManifestResult>): Promise<string | null> => {
		if (!e.channel || !e.version || isDev(e.version)) return null;
		let m = cache.get(e.channel);
		if (!m) {
			m = await o.manifest(e.channel).catch((): ManifestResult => ({ manifest: null, error: "manifest" }));
			cache.set(e.channel, m);
		}
		const target = m.manifest?.components?.[e.kind]?.version;
		return target && isNewerVersion(target, e.version) ? target : null;
	};

	return {
		view() {
			if (none || !last) return null;
			if (stale && now() - last.at > keepMs) return null;
			return { rows: last.rows, stale, hubMachine: last.hubMachine };
		},
		async poll() {
			if (now() < pollPausedUntil) return;
			const r = await req("/v1/inventory");
			if (r && (r.status === 401 || r.status === 403 || r.status === 404)) pollPausedUntil = now() + BACKOFF_MS;
			else if (r?.ok) pollPausedUntil = 0;
			if (r?.status === 404) {
				none = true;
				last = null;
				stale = false;
				return;
			}
			if (!r || !r.ok) {
				stale = true;
				return;
			}
			try {
				const body = (await r.json()) as { entries?: InventoryListed[]; hubMachine?: string };
				if (!Array.isArray(body.entries)) throw new Error("no entries");
				const cache = new Map<string, ManifestResult>();
				const rows: RemoteService[] = [];
				for (const e of body.entries) rows.push({ ...e, latest: await latestFor(e, cache) });
				none = false;
				stale = false;
				last = { at: now(), rows, hubMachine: typeof body.hubMachine === "string" ? body.hubMachine : null };
			} catch {
				stale = true;
			}
		},
		start() {
			if (timers.length) return;
			void this.poll();
			timers.push(setInterval(() => void this.poll(), 5000));
			for (const t of timers) t.unref?.();
		},
		stop() {
			for (const t of timers.splice(0)) clearInterval(t);
		},
	};
}
