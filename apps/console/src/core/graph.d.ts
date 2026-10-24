/**
 * The knowledge graph: merger (the deterministic final stage of the
 * extraction pipeline — vision §1 construction) + derivation (reads).
 *
 * The extraction pipeline is the SOLE graph writer, tree-blind and post-hoc
 * (2026-09-27 cleanup — clear separation of work):
 *
 *   extractor (LLM)  → SessionFindings: the raw reasoning chains —
 *                      propositions (lonely relevant ones included) and
 *                      chains, from the stretch (one batch) PLUS the
 *                      same-source digest (digest-aware, 2026-09-30
 *                      evening: the extractor continues its own source,
 *                      references existing ids verbatim, assembles
 *                      cross-stretch itself). Session propositions carry
 *                      their passage's messageId (2026-10-13) — the
 *                      merger's provenance anchor. Fully trusted: no
 *                      stage re-checks it.
 *   auditor (LLM)    → AuditVerdicts: identity links (local id → an existing
 *                      node, or create) via graph-exploration tools —
 *                      links ONLY (owner, 2026-09-28 evening: the auditor
 *                      never mints edges; cross-source connection happens
 *                      solely through identified equivalences). Never sees
 *                      the source; never drops; never sees chains — its
 *                      input is the fresh propositions only.
 *   merger (HERE)    → mergeFindings(): deterministic ledger appends
 *                      + the chain-simplification maintenance pass
 *                      (2026-09-30 evening — simplifyChains below).
 *
 * The merger is deliberately the ONLY stage that touches the ledgers, and it
 * is pure code: the LLM supplies exactly the judgment calls (what the
 * propositions are, what follows/supports what, whether a proposition IS an
 * existing node), while timestamps/provenance — anything the model could
 * silently mis-copy — are rebuilt deterministically. Idempotent +
 * incremental: edges dedupe by (from,to,type)-already-asserted-by-this-chat,
 * mapping lines dedupe by (chat, sourceId), and coverage entries /
 * sessions.jsonl checkpoints which messages and chats have been extracted
 * (never the same turns twice). No events: the events ledger is GONE
 * (2026-09-27) — the graph carries propositions + edges, nothing else.
 *
 * Identity across re-encounters is the AUDITOR's judgment (link-or-create
 * with an equivalence bias — paraphrases merge), not string matching.
 * A re-extracted session's propositions link to the existing nodes; the
 * link appends a node line whose phrasings join `aliases` and whose
 * provenance unions (getGraph merges lines by id).
 *
 * Derivation below (getGraph / graphSnapshot) is reads only — everything
 * is recomputed from the ledgers. Every function takes the storage ports
 * (core/ports.ts) as explicit parameters — pure core, no adapter imports;
 * the composition root (src/server/stores.ts) wires the fs adapters in.
 */
import type { CoverageEntry } from "./contracts/graph.ts";
import type { AuditVerdicts, GraphChain, SessionFindings, EmissionStats, GraphEdge, GraphNode, GraphSnapshot } from "./contracts.ts";
import type { ChatStore, GraphStore } from "./ports.ts";
/** The storage ports every graph operation needs, passed explicitly. */
export interface GraphDeps {
    chatStore: ChatStore;
    graphStore: GraphStore;
}
/** What one merge run merges FROM (the caller supplies it — the merger never
 *  reads the chat store): the coverage checkpoint for a session batch, or —
 *  for the format-agnostic notes front door (2026-09-13) — no coverage at
 *  all: the whole-file checkpoint stamps the import.
 *
 *  Coverage (vision-extraction-coverage.md, settled 2026-09-15): a chat merge
 *  passes the BATCH it extracted — the caller computed the fingerprints
 *  before the run, from the same snapshot the merger sees — and the final
 *  step appends one CoverageEntry per message on success ("covered" means
 *  exactly this merge happened). The notes path passes neither and keeps
 *  the whole-file checkpoint. */
export interface MergeSource {
    foldedAt: string;
    /** The batch being merged (chat path): one entry per message in the
     *  extracted batch — undefined (notes path / coverage-less callers) →
     *  the legacy whole-chat checkpoint is written instead. */
    coverage?: CoverageEntry[];
}
/**
 * Merge one job's audited findings into the graph ledgers — the pipeline's
 * apply stage. Deterministic. Each chunk/batch job merges INDEPENDENTLY
 * (owner, 2026-09-29): resolution is a job-local in-memory map from this
 * submit's proposition ids to graph node ids — nothing persists between
 * jobs, so no job can see (or collide with) another's ids. Cross-job
 * identity is the auditor's alone: it links this job's propositions to
 * existing nodes before this function is ever called.
 *
 * Identity inside the job is the auditor's link-or-create verdict: `linkTo`
 * an existing node (validated against the ledger — an unknown id falls
 * back to create) appends a LINK line (the job's phrasings join the node's
 * aliases and the provenance unions; getGraph merges lines by id);
 * absent → a new node.
 *
 * `chatId` is the job's source key: a real chat, or a notes source id
 * ("src_…") for the format-agnostic import path. The `source` parameter
 * carries the checkpoint stamp; the merger itself is chat-store-free.
 */
export declare function mergeFindings(chatId: string, findings: SessionFindings, verdicts: AuditVerdicts, deps: GraphDeps, source: MergeSource): EmissionStats;
/** The deterministic chain-simplification pass (owner, 2026-09-30
 *  evening): strips redundant derivations — same-conclusion chains whose
 *  premises add nothing a leaner kept chain doesn't already derive. Pure
 *  over the input list; the caller owns the ledger rewrite. Exported for
 *  tests.
 *
 *  Same (premises, conclusion) lines are ONE logical chain (read-time
 *  merge semantics) — a key is kept or dropped as a whole, every
 *  provenance line with it. */
export declare function simplifyChains(lines: GraphChain[]): GraphChain[];
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
export declare function getGraph(graphStore: Pick<GraphStore, "readNodes" | "readChains">): DerivedGraph;
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
export declare function deriveView(graph: DerivedGraph): {
    nodes: GraphNode[];
    edges: GraphEdge[];
    logicalEdges: GraphEdge[];
    impLinks: Array<{
        id: string;
        premises: string[];
        conclusion: string;
    }>;
};
/** Everything the home graph view needs, in one fetch (shape: contracts). */
export declare function graphSnapshot(deps: GraphDeps): GraphSnapshot;
/** One session in the prober's graph view: every provenance anchor the
 *  graph can name — a real chat (deep-linkable) or an imported notes file
 *  (owner ruling 2026-09-23: files are birth-sessions too, kind "file").
 *  The prober's session-list tool renders these; the per-session view is
 *  graphSessionPropositions below. Pure derivation over the same ports
 *  the snapshot reads — Teacher's tool handlers call these in-process. */
export interface GraphSessionEntry {
    /** chatId or notes source id ("src_…") — the birth-session key. */
    id: string;
    /** The chat's title, or the file's path — the cluster label's source. */
    name: string;
    /** A real chat (its record still exists) or an imported notes file. */
    kind: "chat" | "file";
    /** When the session began: the chat's createdAt, or the file's
     *  importedAt. null when no record can date it. */
    createdAt: string | null;
    /** Most recent activity: the chat's updatedAt, or the file's
     *  importedAt. null when no record can date it. */
    updatedAt: string | null;
    /** How many propositions were BORN in this session (birth-session
     *  clustering's count — shared/re-encountered nodes count for their
     *  birth session only). */
    propositions: number;
}
/** The prober's session list: every birth session, most-recently-active
 *  first (undatable records sink, in stable id order). */
export declare function graphSessionIndex(deps: GraphDeps): GraphSessionEntry[];
/** One birth proposition of one session — WHAT WAS COVERED there (2026-09-27
 *  cleanup: no understanding levels; assessment is
 *  territory and nothing writes it until that module exists). */
export interface GraphSessionProposition {
    nodeId: string;
    /** The compact handle — the same name the canvas shows. */
    name: string;
}
/** The propositions BORN in one session — what that session first
 *  articulated. Members sorted by node id — deterministic. */
export declare function graphSessionPropositions(deps: GraphDeps, sessionId: string): GraphSessionProposition[];
export type { EmissionStats };
//# sourceMappingURL=graph.d.ts.map