import { threadListItem } from "./thread-adapter.ts";
import type { ChildThread } from "./subagents.ts";

type Row = ReturnType<typeof threadListItem>;
type ThreadWire = { id: string; title: string; status?: "idle" | "busy" | "needs-you"; closed?: boolean; kind?: string; workspace?: { branch?: string } } & Omit<ChildThread, "id" | "title">;

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
 * unreachable: keep the last roster, every wolf marked offline). A wolf is offline when its status says so or its
 * threads fetch failed (`threadsOk` false). Wolves stay listed whatever their state; they never drop out.
 */
export function foldWolfRoster(
	prev: readonly WolfStatus[] | null | undefined,
	wolves: readonly { name: string; status?: string }[] | undefined,
	threadsOk: Readonly<Record<string, boolean>> = {},
): WolfStatus[] {
	if (!wolves) return (prev ?? []).map((w) => ({ name: w.name, online: false }));
	return wolves.map((w) => ({ name: w.name, online: w.status !== "offline" && threadsOk[w.name] !== false }));
}

/**
 * The light liveness tick: exactly ONE `/api/wolves` call, no per-wolf thread fetches. `recovered` lists wolves that were
 * offline (or unknown) and are online now; only those get a threads fetch. Server unreachable: last roster, all offline.
 */
export async function checkRoster(
	fetchFn: (url: string, init?: { cache?: "no-store" }) => Promise<{ json(): Promise<unknown> }>,
	prev: readonly WolfStatus[],
): Promise<{ roster: WolfStatus[]; recovered: string[] }> {
	let wolves: { name: string; status?: string }[] | undefined;
	try {
		const d = (await (await fetchFn("/api/wolves", { cache: "no-store" })).json()) as { wolves?: { name: string; status?: string }[] };
		wolves = Array.isArray(d.wolves) ? d.wolves : undefined;
	} catch {
		wolves = undefined;
	}
	const roster = foldWolfRoster(prev, wolves);
	const wasOnline = new Set(prev.filter((w) => w.online).map((w) => w.name));
	return { roster, recovered: roster.filter((w) => w.online && !wasOnline.has(w.name)).map((w) => w.name) };
}
