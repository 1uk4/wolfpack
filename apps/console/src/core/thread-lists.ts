import { threadListItem } from "./thread-adapter.ts";
import type { ChildThread } from "./subagents.ts";

type Row = ReturnType<typeof threadListItem>;
type ThreadWire = { id: string; title: string; status?: "idle" | "busy" | "needs-you"; closed?: boolean; kind?: string; workspace?: { branch?: string }; settings?: { color?: string } } & Omit<ChildThread, "id" | "title">;

/**
 * The sidebar list from one fetch per wolf. A wolf whose fetch failed (`threads` undefined: down, 5xx, bad body) keeps
 * its previous rows instead of failing the whole refresh. Otherwise one unreachable wolf froze the entire list, and a
 * needs-you dot on a healthy wolf could never clear.
 */
export function foldWolfThreads<P extends { meta?: string }>(prev: readonly P[] | null | undefined, results: readonly { wolf: string; threads?: readonly ThreadWire[] }[]): (Row | P)[] {
	return results.flatMap((r): (Row | P)[] => (r.threads ? r.threads.map((t) => threadListItem(r.wolf, t)) : (prev ?? []).filter((p) => p.meta === r.wolf)));
}

export type WolfStatus = { name: string; online: boolean };

/**
 * The wolf roster shown above the session list. `wolves` is the /api/wolves answer (undefined = the server itself was
 * unreachable or failed: keep the last roster, every wolf marked offline). ONLY the roster's `status` decides online/offline;
 * a failed threads fetch keeps stale rows but never flips a wolf. Wolves stay listed whatever their state.
 */
export function foldWolfRoster(prev: readonly WolfStatus[] | null | undefined, wolves: readonly { name: string; status?: string }[] | undefined): WolfStatus[] {
	if (!wolves) return (prev ?? []).map((w) => ({ name: w.name, online: false }));
	return wolves.map((w) => ({ name: w.name, online: w.status !== "offline" }));
}

type RosterResponse = { ok: boolean; status: number; json(): Promise<unknown> };

/**
 * The light liveness tick: exactly ONE `/api/wolves` call, no per-wolf thread fetches. `recovered` lists wolves that were
 * offline (or unknown) and are online now; only those get a threads fetch. A 401 is an auth failure, not "offline": the
 * roster is left as it was (`authLost`; the console's fetch wrapper takes the browser to /pair). Any other failure
 * (5xx, network, bad body): last roster, all offline.
 */
export async function checkRoster(
	fetchFn: (url: string, init?: { cache?: "no-store" }) => Promise<RosterResponse>,
	prev: readonly WolfStatus[],
): Promise<{ roster: WolfStatus[]; recovered: string[]; authLost?: true }> {
	let wolves: { name: string; status?: string }[] | undefined;
	try {
		const res = await fetchFn("/api/wolves", { cache: "no-store" });
		if (res.status === 401) return { roster: [...prev], recovered: [], authLost: true };
		const d = res.ok ? ((await res.json()) as { wolves?: { name: string; status?: string }[] }) : undefined;
		wolves = Array.isArray(d?.wolves) ? d.wolves : undefined;
	} catch {
		wolves = undefined;
	}
	const roster = foldWolfRoster(prev, wolves);
	const wasOnline = new Set(prev.filter((w) => w.online).map((w) => w.name));
	return { roster, recovered: roster.filter((w) => w.online && !wasOnline.has(w.name)).map((w) => w.name) };
}

type TickDoc = { visibilityState: string; addEventListener(t: "visibilitychange", f: () => void): void; removeEventListener(t: "visibilitychange", f: () => void): void };

/** Runs `tick` every `ms` while the document is visible, and once when it becomes visible again. Returns the cleanup. */
export function startVisibleTimer(tick: () => void, ms: number, doc: TickDoc): () => void {
	const run = () => {
		if (doc.visibilityState === "visible") tick();
	};
	const id = setInterval(run, ms);
	doc.addEventListener("visibilitychange", run);
	return () => {
		clearInterval(id);
		doc.removeEventListener("visibilitychange", run);
	};
}
