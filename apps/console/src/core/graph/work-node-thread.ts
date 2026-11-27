/**
 * Which thread a graph work node stands for (work-wolfpack-RCzmuaj). A feature's thread carries the slug `feature-<full work id>`
 * (`feature-work-<domain>-<id>`, the same convention live-state's featureOfThread reads); a task uses its parent feature's thread,
 * found by following the `partOf` edges up to the first feature. Anything else (initiative, entry, factory) has none.
 */
import type { KbGraph } from "../kb/kb.ts";
import { threadSlug } from "../thread/thread-adapter.ts";
import type { ThreadsByWolf } from "../thread/chat-bar.ts";

const WORK = "work:";

export function threadForWorkNode(
	graph: Pick<KbGraph, "nodes" | "edges">,
	nodeId: string,
	threads: ThreadsByWolf,
): { wolf: string; threadId: string } | null {
	if (!nodeId.startsWith(WORK)) return null;
	const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
	const parentOf = new Map<string, string>();
	for (const e of graph.edges) if (e.kind === "partOf" && !parentOf.has(e.source)) parentOf.set(e.source, e.target);
	let cur: string | undefined = nodeId;
	const seen = new Set<string>();
	while (cur && !seen.has(cur)) {
		seen.add(cur);
		const n = byId.get(cur);
		if (!n || n.kind !== "work") return null;
		if (n.workKind === "feature") {
			if (!n.domain) return null;
			const slug = `feature-work-${n.domain}-${cur.slice(WORK.length)}`.toLowerCase();
			for (const [wolf, list] of Object.entries(threads)) {
				for (const t of list ?? []) {
					if (threadSlug(wolf, t.id).toLowerCase() !== slug) continue;
					if (!t.closed) return { wolf, threadId: t.id }; // a closed thread cannot be attached
				}
			}
			return null;
		}
		cur = parentOf.get(cur);
	}
	return null;
}
