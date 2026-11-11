/**
 * The console's side of the pack inventory (work-wolfpack-ZproKxi): polls the hub's GET /v1/inventory (every service on every machine
 * and the release it runs) and sends this console's own heartbeat to POST /v1/inventory/report. A hub without the routes (404) means
 * "no inventory": the panel then shows local probes and presence only. `behind` is judged against the manifest of the channel the
 * service itself reported; a service with no channel or a `-dev` version gets no verdict.
 */
import { CONSOLE_REPORT_EVERY_MS, type InventoryEntry, type InventoryListed, type ManifestResult } from "@wolfpack/protocol";
import { isNewerVersion } from "../../core/pack/pack-health-view.ts";

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
	/** This console's own heartbeat entry. */
	self: () => InventoryEntry;
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
	/** Send this console's heartbeat once. */
	heartbeat(): Promise<void>;
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
	let beatPausedUntil = 0;
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
		async heartbeat() {
			if (now() < beatPausedUntil) return;
			const r = await req("/v1/inventory/report", { method: "POST", body: JSON.stringify({ entry: o.self() }) });
			if (r && (r.status === 401 || r.status === 403 || r.status === 404)) beatPausedUntil = now() + BACKOFF_MS;
			else if (r?.ok) beatPausedUntil = 0;
		},
		start() {
			if (timers.length) return;
			void this.poll();
			void this.heartbeat();
			timers.push(setInterval(() => void this.poll(), 5000), setInterval(() => void this.heartbeat(), CONSOLE_REPORT_EVERY_MS));
			for (const t of timers) t.unref?.();
		},
		stop() {
			for (const t of timers.splice(0)) clearInterval(t);
		},
	};
}
