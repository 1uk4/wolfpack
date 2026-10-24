/**
 * Knowledge-graph contracts — nodes, chains, the rendered snapshot
 *
 * Every node is a proposition; chains (arguments) are the stored truth and
 * edges are a derived view; provenance is message-granular. The graph is
 * INERT in the console today (rendering only — nothing writes the ledgers);
 * the contracts stay for the graph view's later reuse.
 *
 * Part of the domain-split contracts (src/core/contracts/): pure types +
 * tiny pure helpers.
 */
// ─── Knowledge graph (vision §1 — global, cross-session) ────────────────────

/** One relation of the DERIVED view — chains are the stored truth (owner,
 *  2026-09-30: "the graph is a lossy image of what is truly stored"), and
 *  the snapshot derives UNTYPED arrows from them: every premise → the
 *  chain's implication node, the implication node → the conclusion.
 *  Nothing stores or mutates these — they are rebuilt after every change
 *  and never converted back. */
export interface GraphEdge {
	from: string;
	to: string;
}

/** One stored REASONING CHAIN — an argument: premises that JOINTLY entail
 *  the conclusion (chains-primary, owner 2026-09-30). Independent arguments
 *  for the same conclusion are separate chains (they may share `conclusion`);
 *  co-premises within one chain are used TOGETHER. The snapshot derives an
 *  implication NODE per chain (id = the chain id — the arg_ namespace is its
 *  own, collision-free with n_) plus untyped edges premises → imp →
 *  conclusion. A chain referencing a dead node dies with it (full death
 *  cascades through every referencing chain). */
export interface GraphChain {
	/** "arg_" + nanoid-like (store-assigned, the node-minting pattern). */
	id: string;
	/** Node ids of the argument's premises — at least one, jointly
	 *  sufficient. Extractor-local at the wire; node ids after resolution. */
	premises: string[];
	/** The node id the premises jointly imply. */
	conclusion: string;
	/** Every (chat, message) point where this argument was asserted —
	 *  unioned across assertion lines at read time. */
	provenance: ProvenancePoint[];
	createdAt: string;
}

/** One provenance point — message-granular (DECIDED 2026-09-02): nodes and
 *  edges record every (chat, message) where they came up, deep-linkable to
 *  the exact transcript point. */
export interface ProvenancePoint {
	/** The chat this point anchors to — or a notes source id ("src_…"):
	 *  imports carry no message anchors (provenance is the file itself,
	 *  recorded through the mapping line + the source record). */
	chatId: string;
	messageId: string;
}

/** The graph-family format version this build writes and understands
 *  (the format.json sidecar — src/store/graph-format.ts). */
export const CURRENT_GRAPH_FORMAT_VERSION = 1;


export interface GraphNode {
	/** Opaque stable id, store-assigned: "n_" + nanoid-like. */
	id: string;
	/** A very short label for the node — a compact handle like a glossary
	 *  headword ("Will to power", "Divine command theory"): what the graph
	 *  shows at a glance. Presentational only — not unique, not an identity
	 *  key, never precise: the statement carries the precision. Set at
	 *  creation (first line defines); a link-append never changes it. */
	name: string;
	/** The minimal proposition — one true, self-contained statement, at
	 *  full precision. The IDENTITY ANCHOR: the auditor recognizes a
	 *  re-encounter by judgment against this (link-or-create), not by
	 *  string matching. Shown in the detail card; the canvas label is the
	 *  name. */
	statement: string;
	/** Verbatim phrasings sessions used for this proposition (the identity
	 *  audit trail — how the world said what the node says). */
	aliases: string[];
	createdAt: string;
	/** Every (chat, message) point where this proposition came up. */
	provenance: ProvenancePoint[];
}

/**
 * Store format (src/store/graph.ts): JSONL ledgers at config.LEDGER_FILES
 * (nodes/chains), append-only. Edges are NEVER stored — the derived view
 * (implication nodes + untyped arrows) is rebuilt from chains on every read.
 *
 *   nodes.jsonl    one line per node — the FIRST line for an id defines
 *                  name/statement/createdAt; later lines for the same id
 *                  are link-appends: their statements/aliases join
 *                  `aliases`, their provenance unions; getGraph merges by id.
 *   chains.jsonl   one line per chain ASSERTION; readers merge by
 *                  (premises, conclusion), unioning provenance — the
 *                  first line's arg_ id is the chain's identity.
 */

/** The GET /api/graph payload — everything the home view's PURE renderer needs. */

/** One rendered cluster in the snapshot payload (vision §1). Members are
 * node ids; the renderer draws the hull from member positions at draw
 * time and gates the label inversely on the node-label zoom control. */
export interface Cluster {
	/** The labeling record id when claimed; unlabeled clusters still
	 * appear (hull, no name) with a member-hash id. */
	id: string;
	/** null until the naming call has minted/claimed a labeling. */
	label: string | null;
	/** Node ids, sorted. Hull + centroid are renderer concerns. */
	members: string[];
}

export interface GraphSnapshot {
	/** Proposition nodes + the DERIVED implication nodes (one per chain,
	 *  id = chain id) — what the canvas renders. */
	nodes: GraphNode[];
	/** The STORED proposition nodes alone (no derived implication nodes)
	 *  — the stored truth, like `chains`: consumers that read the world
	 *  (the chain table) take this list, never the canvas image. */
	propositions: GraphNode[];
	/** DERIVED untyped arrows: premise → imp → conclusion. A lossy image
	 *  of the stored chains — rebuilt after every change, never stored. */
	edges: GraphEdge[];
	/** DERIVED LOGICAL arrows: every chain contracted to direct premise→
	 *  conclusion over PROPOSITION ids only (the imp hop collapsed). The
	 *  depth pass consumes these — inference depth is a property of
	 *  propositions, never of the geometry point (owner, 2026-09-30). */
	logicalEdges: GraphEdge[];
	/** DERIVED imp linkage (one per MULTI-premise live chain): the depth
	 *  pass anchors each junction at the average of the highest premise
	 *  row and the conclusion's row (owner, 2026-09-30) — strictly
	 *  above the premises, strictly below the conclusion. */
	impLinks: Array<{ id: string; premises: string[]; conclusion: string }>;
	/** The STORED reasoning chains (merged by (premises, conclusion) at
	 *  read): the chain table's and the practice pipeline's input — they
	 * read the truth, never the derived fan-out. */
	chains: GraphChain[];
	/** chatId → title, for every chat that touched the graph. */
	sessions: Record<string, string>;
	/** nodeId → chatIds that touched the node (click-through provenance). */
	nodeSessions: Record<string, string[]>;
	/** Birth-session communities (core/session-clusters.ts: each
	 * proposition joins the cluster of the session that birthed it —
	 * session provenance, no Louvain, no embeddings), MIN_CLUSTER_SIZE
	 * ≥ 3 as the hull presentation rule. Propositions only — implication
	 * nodes are never partitioned. Purely provenance-derived — never
	 * depends on layout. */
	clusters: Cluster[];
	/** Resting layout positions per node id, when a positions ledger
	 *  exists (core/layout.ts settle writes it). Absent on a fresh graph —
	 *  the view then falls back to its own one-shot forceAtlas2 pass. */
	positions?: Record<string, Position>;
}

/** A node's resting position in layout space (the positions ledger). */
export interface Position {
	x: number;
	y: number;
}

/** The auto-title's character cap (owner, 2026-10-06): long enough to
 *  stay informative in the sidebar and the top bar, short enough that a
 *  first message never reads as a paragraph. Tunable — one number, one
 *  place. */
export const TITLE_MAX_CHARS = 72;

/** Derive a short chat title from the learner's first message (pure).
 *  Smart truncation (owner, 2026-10-06): the cut snaps to a word boundary
 *  AT OR UNDER the cap — a title never ends mid-word. The one exception
 *  is a single word longer than the cap (rare, but real: identifiers,
 *  URLs): it cuts at the cap, splitting the word. Whitespace collapses to
 *  single spaces first, so boundaries are always single-space boundaries.
 *  Used on chat creation; deterministic so tests can pin it. */
export function titleFromPrompt(prompt: string): string {
	const oneLine = prompt.replace(/\s+/g, " ").trim();
	if (oneLine.length <= TITLE_MAX_CHARS) return oneLine;
	// Last space among the first TITLE_MAX_CHARS characters; the cut sits
	// before it so no trailing space rides into the title.
	let cut = -1;
	for (let i = TITLE_MAX_CHARS; i > 0; i--) {
		if (oneLine[i - 1] === " ") {
			cut = i - 1;
			break;
		}
	}
	// One long word: no boundary exists under the cap — split it (owner's
	// special case). This also lands correctly when the first word exactly
	// fills the cap: cutting at the cap IS the boundary.
	if (cut < 0) cut = TITLE_MAX_CHARS;
	return `${oneLine.slice(0, cut)}…`;
}
