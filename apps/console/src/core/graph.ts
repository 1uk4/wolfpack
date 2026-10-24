/**
 * The knowledge graph derivation (reads only — everything is recomputed
 * from the ledgers). Every function takes the storage ports
 * (core/ports.ts) as explicit parameters — pure core, no adapter imports;
 * the composition root (src/server/stores.ts) wires the fs adapters in.
 *
 * The graph is currently INERT: the extraction pipeline that wrote the
 * ledgers is gone; this module renders whatever the ledgers hold.
 */

import type { Cluster, GraphChain, GraphEdge, GraphNode, GraphSnapshot, ProvenancePoint } from "./contracts.ts";
import { MIN_CLUSTER_SIZE } from "./clusters.ts";
import { attachImpToCommunities, birthSessionPartition } from "./session-clusters.ts";
import type { ChatStore, GraphStore } from "./ports.ts";

/** The storage ports every graph operation needs, passed explicitly. */
export interface GraphDeps {
	chatStore: ChatStore;
	graphStore: GraphStore;
}

const samePoint = (a: ProvenancePoint, b: ProvenancePoint): boolean =>
	a.chatId === b.chatId && a.messageId === b.messageId;

/** A chain's merge key: sorted premises + conclusion — the identity an
 *  assertion re-stating the same argument merges under. */
function chainKey(premises: ReadonlyArray<string>, conclusion: string): string {
	return `${[...premises].sort().join("+")}>${conclusion}`;
}

/** One chain rendered as a readable line: "A, B → C". */
function formatChainLine(
	chain: Pick<GraphChain, "premises" | "conclusion">,
	propositions: Readonly<Record<string, { name: string }>>,
): string {
	const nameOf = (id: string) => propositions[id]?.name ?? id;
	const premises = [...chain.premises].sort().map(nameOf).join(", ");
	return premises !== ""
		? `${premises} → ${nameOf(chain.conclusion)}`
		: `${nameOf(chain.conclusion)} (no premises)`;
}

// ─── derivation (reads only — everything below is recomputable) ─────────────

/** The merged STORED truth: propositions + chains (chains-primary, owner
 *  2026-09-30). `nodes` are PROPOSITIONS ONLY — no derived implication
 *  nodes; the auditor's and prober's views see the world, not the
 *  rendering. The canvas-facing VIEW (implication nodes + untyped
 *  arrows) is deriveView() below — the lossy image. */
export interface DerivedGraph {
	nodes: GraphNode[];
	chains: GraphChain[];
}

/**
 * The whole graph from the ledgers. Node LINES may repeat an id (link-
 * appends): the FIRST line defines name/statement/createdAt; later
 * lines' statements and aliases join `aliases`, provenance unions — the
 * name never changes after creation. Chain LINES are assertions, merged
 * by (premises, conclusion) with unioned provenance; the first line's
 * arg_ id / premises / createdAt are the chain's identity.
 * `store events, derive state` — this is the only reader that matters.
 */
export function getGraph(graphStore: Pick<GraphStore, "readNodes" | "readChains">): DerivedGraph {
	// Merge node lines by id (first line defines; later lines add phrasings).
	const byId = new Map<string, GraphNode>();
	for (const line of graphStore.readNodes()) {
		const existing = byId.get(line.id);
		if (!existing) {
			byId.set(line.id, { ...line, aliases: [...line.aliases], provenance: [...line.provenance] });
			continue;
		}
		// A later line's statement is a phrasing, not a replacement.
		for (const phrasing of [line.statement, ...line.aliases]) {
			if (phrasing.length > 0 && !existing.aliases.includes(phrasing)) existing.aliases.push(phrasing);
		}
		for (const pt of line.provenance) {
			if (!existing.provenance.some((q) => samePoint(q, pt))) existing.provenance.push(pt);
		}
	}

	// Merge chain assertion lines by (premises, conclusion): the first
	// line's id/premises/createdAt stand, provenance unions.
	const chains: GraphChain[] = [];
	const byKey = new Map<string, GraphChain>();
	for (const line of graphStore.readChains()) {
		const key = chainKey(line.premises, line.conclusion);
		const existing = byKey.get(key);
		if (existing) {
			for (const pt of line.provenance) {
				if (!existing.provenance.some((q) => samePoint(q, pt))) existing.provenance.push(pt);
			}
		} else {
			const chain: GraphChain = { ...line, premises: [...line.premises], provenance: [...line.provenance] };
			byKey.set(key, chain);
			chains.push(chain);
		}
	}
	return { nodes: [...byId.values()], chains };
}

/** The DERIVED view — what the canvas renders. A SINGLE-premise chain
 *  collapses to ONE direct arrow premise → conclusion (no imp node:
 *  a chain is always N-in/1-out, so one premise is the degenerate
 *  1-in-1-out case). A MULTI-premise chain mints an implication NODE
 *  (id = the chain's arg_ id; name "⟹"; statement = the chain line;
 *  the chain's provenance/createdAt) plus arrows: each premise → the
 *  implication node, the implication node → the conclusion — the
 *  canvas renders imp nodes as pure geometry (owner, rendering arc:
 *  invisible, unpickable; co-premise lines converge headless to a
 *  point, one arrowed line leaves it). Physics keeps imp nodes as
 *  regular citizens (half link distance — layout.ts). Dangling chains
 *  (a member node missing) drop here — the deletion cascades should
 *  prevent them; this is the honest belt. */
export function deriveView(graph: DerivedGraph): {
	nodes: GraphNode[];
	edges: GraphEdge[];
	logicalEdges: GraphEdge[];
	impLinks: Array<{ id: string; premises: string[]; conclusion: string }>;
} {
	const names: Record<string, { name: string }> = {};
	for (const node of graph.nodes) names[node.id] = { name: node.name };
	const live = new Set(graph.nodes.map((node) => node.id));
	const impNodes: GraphNode[] = [];
	const edges: GraphEdge[] = [];
	// The LOGICAL edge set (owner, 2026-09-30): every chain contracted to
	// direct premise→conclusion arrows over PROPOSITION ids only —
	// what inference semantics (the depth pass) consumes. The drawn edges
	// are the canvas image; these are the meaning.
	const impLinks: Array<{ id: string; premises: string[]; conclusion: string }> = [];
	const logicalEdges: GraphEdge[] = [];
	const logicalSeen = new Set<string>();
	const emitLogical = (from: string, to: string): void => {
		const key = from + "\u0000" + to;
		if (logicalSeen.has(key)) return;
		logicalSeen.add(key);
		logicalEdges.push({ from, to });
	};
	for (const chain of graph.chains) {
		if (!live.has(chain.conclusion) || !chain.premises.every((premise) => live.has(premise))) continue;
		for (const premise of chain.premises) emitLogical(premise, chain.conclusion);
		// Single premise: the argument IS a plain arrow — no geometry
		// point needed (the 1-in/1-out collapse; rendering arc, owner).
		if (chain.premises.length === 1) {
			edges.push({ from: chain.premises[0]!, to: chain.conclusion });
			continue;
		}
		impNodes.push({
			id: chain.id,
			name: "⟹",
			statement: formatChainLine(chain, names),
			aliases: [],
			createdAt: chain.createdAt,
			provenance: [...chain.provenance],
		});
		// The junction's linkage — what the depth pass needs for the
		// midpoint anchor (owner, 2026-09-30).
		impLinks.push({ id: chain.id, premises: [...chain.premises], conclusion: chain.conclusion });
		for (const premise of chain.premises) edges.push({ from: premise, to: chain.id });
		edges.push({ from: chain.id, to: chain.conclusion });
	}
	return { nodes: [...graph.nodes, ...impNodes], edges, logicalEdges, impLinks };
}

// ─── the /api/graph payload ──────────────────────────────────────────────────

/** Everything the home graph view needs, in one fetch (shape: contracts). */
export function graphSnapshot(deps: GraphDeps): GraphSnapshot {
	const graph = getGraph(deps.graphStore);
	// The canvas-facing lossy image: propositions + derived implication
	// nodes, untyped arrows. `chains` (the stored truth) ride along for
	// the chain table — it reads the truth, never the derived fan-out,
	// never the derived fan-out.
	const view = deriveView(graph);
	const nodes = view.nodes;

	const nodeChats = new Map<string, Set<string>>();
	const touch = (nodeId: string, chatId: string): void => {
		let chats = nodeChats.get(nodeId);
		if (!chats) {
			chats = new Set();
			nodeChats.set(nodeId, chats);
		}
		chats.add(chatId);
	};
	for (const node of nodes) {
		for (const pt of node.provenance) touch(node.id, pt.chatId);
	}
	// Labels for every source the graph can point back at: real chats
	// (title, deep-linkable).
	const sourceIds = new Set<string>();
	for (const chats of nodeChats.values()) {
		for (const id of chats) sourceIds.add(id);
	}
	const sessions: Record<string, string> = {};
	for (const id of sourceIds) {
		const chat = deps.chatStore.getChat(id);
		if (chat) sessions[id] = chat.title;
	}

	const nodeSessions: Record<string, string[]> = {};
	for (const [nodeId, chats] of nodeChats) {
		const ids = [...chats].filter((id) => sessions[id] !== undefined);
		if (ids.length > 0) nodeSessions[nodeId] = ids;
	}

	// BIRTH-SESSION CLUSTERS (wave 7, owner-locked 2026-09-23): embeddings
	// are dead — a cluster is the SESSION THAT CREATED ITS PROPOSITIONS,
	// derived on read from provenance (core/session-clusters.ts). The label
	// is the session's NAME (chat title / file path): no LLM naming pass, no
	// persisted partition to invalidate. MIN_CLUSTER_SIZE stays the hull
	// presentation rule (a region needs >= 3 propositions for a hull). A
	// birth session whose record is gone (deleted chat) keeps its members
	// but renders unlabeled — honest, never guessed.
	// PROPOSITIONS ONLY (owner, 2026-09-30): derived implication nodes
	// never partition — the stored world clusters, its image follows.
	const communities = birthSessionPartition(graph.nodes);
	const clusters: Cluster[] = communities
		.filter((community) => community.members.length >= MIN_CLUSTER_SIZE)
		.map((community) => ({
			id: community.id,
			label: sessions[community.id] ?? null,
			members: community.members,
		}));
	// IMP-NODE CLUSTER ASSIGNMENT (owner, 2026-09-30): majority among the
	// premises' birth sessions, ties to the chain's own birth — attached
	// AFTER the hull filter so a two-proposition community + its bundle
	// never resurrects a hull (the filter counts propositions). Both
	// cluster-membership consumers — the sim's centroid pull and the
	// canvas's region rasterization — read it through this one list.
	attachImpToCommunities(clusters, graph.nodes, graph.chains);

	// Resting layout (Option A): the positions ledger, when the settle has
	// ever run. Absent on a fresh graph — the view falls back to its own
	// one-shot pass until the first merge writes the ledger.
	const positions = deps.graphStore.readPositions();

	return {
		nodes,
		propositions: graph.nodes,
		edges: view.edges,
		logicalEdges: view.logicalEdges,
		impLinks: view.impLinks,
		chains: graph.chains,
		sessions,
		nodeSessions,
		clusters,
		...(Object.keys(positions).length > 0 ? { positions } : {}),
	};
}
