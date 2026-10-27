import { threadListItem } from "./thread-adapter.ts";
import type { ChildThread } from "./subagents.ts";

type Row = ReturnType<typeof threadListItem>;
type ThreadWire = { id: string; title: string; status?: "idle" | "busy" | "needs-you" } & Omit<ChildThread, "id" | "title">;

/**
 * The sidebar list from one fetch per wolf. A wolf whose fetch failed (`threads` undefined: down, 5xx, bad body) keeps
 * its previous rows instead of failing the whole refresh. Otherwise one unreachable wolf froze the entire list, and a
 * needs-you dot on a healthy wolf could never clear.
 */
export function foldWolfThreads<P extends { meta?: string }>(prev: readonly P[] | null | undefined, results: readonly { wolf: string; threads?: readonly ThreadWire[] }[]): (Row | P)[] {
	return results.flatMap((r): (Row | P)[] => (r.threads ? r.threads.map((t) => threadListItem(r.wolf, t)) : (prev ?? []).filter((p) => p.meta === r.wolf)));
}
