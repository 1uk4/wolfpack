/**
 * Graph ledger store + node deletion + derivation tests (the graph is INERT
 * in the console — nothing writes the ledgers — but its store, deletion, and
 * derivation stay pinned for the later knowledge-graph reuse).
 *
 * Ledger isolation: PATHS is fixed at import time, so the data/graph
 * ledgers are backed up and cleared before the suite and restored after
 * (try/finally-shaped: the after() hook always runs, even on failure).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { after, describe, it } from "node:test";
import type { GraphChain, GraphNode } from "../src/core/contracts.ts";
import { deriveView, getGraph, graphSnapshot, type GraphDeps } from "../src/core/graph.ts";
import { deleteNodeTraces, type NodeDeletionStats } from "../src/core/graph-deletion.ts";
import { deleteGraphNode, graphRevision } from "../src/server/graph.ts";
import { graphStore } from "../src/store/graph.ts";
import { chatStore } from "../src/store/chats.ts";
import { LEDGER_FILES, PATHS } from "../config.ts";

/** The wired fs adapters, exactly what src/server/stores.ts passes in production. */
const graphDeps = { chatStore, graphStore } as const satisfies GraphDeps;

// ─── ledger isolation (backup-and-clear of data/graph/*.jsonl) ──────────────

const LEDGER_PATHS = [...Object.values(LEDGER_FILES)];
const backups: Array<{ file: string; bak: string }> = [];
const createdChats: string[] = [];

fs.mkdirSync(PATHS.graph, { recursive: true });
for (const file of LEDGER_PATHS) {
	if (fs.existsSync(file)) {
		const bak = `${file}.w5test.bak`;
		fs.renameSync(file, bak);
		backups.push({ file, bak });
	}
}

after(() => {
	for (const file of LEDGER_PATHS) {
		try {
			fs.unlinkSync(file);
		} catch {
			/* nothing was written here */
		}
	}
	for (const { file, bak } of backups) fs.renameSync(bak, file);
	for (const id of createdChats) {
		try {
			fs.unlinkSync(`${PATHS.chats}/${id}.json`);
		} catch {
			/* already gone */
		}
	}
});


// ─── store primitives ────────────────────────────────────────────────────────

describe("graph ledger store", () => {
	it("round-trips lines and skips corrupt / foreign-shaped lines (strict reads)", () => {
		const node = {
			id: "n_storetest",
			name: "Store test",
			statement: "Store test, elaborated.",
			aliases: [] as string[],
			createdAt: "2026-08-22T00:00:00.000Z",
			provenance: [{ chatId: "chat_c", messageId: "m1" }],
		};
		graphStore.appendNode(node);
		// A torn append and a pre-name-pivot node (old schema: description, no
		// name) — both skipped by the strict guard.
		fs.appendFileSync(
			LEDGER_FILES.nodes,
			`{not json}\n${JSON.stringify({ id: "legacy", statement: "Legacy shape", description: "Old schema.", aliases: [], createdAt: "2026-08-22T00:00:00.000Z", provenance: [] })}\n`,
			"utf-8",
		);
		const nodes = graphStore.readNodes().filter((n) => n.id === "n_storetest" || n.id === "legacy");
		assert.equal(nodes.length, 1);
		assert.equal(nodes[0]!.name, "Store test");
		assert.equal(nodes[0]!.statement, "Store test, elaborated.");
		assert.deepEqual(nodes[0]!.provenance, [{ chatId: "chat_c", messageId: "m1" }]);
	});


	it("returns RAW node lines — repeated ids (link-appends) are each their own line; getGraph merges", () => {
		const line = (msgId: string) =>
			JSON.stringify({
				id: "n_linktest",
				name: "Link test",
				statement: `Phrasing ${msgId}`,
				aliases: [],
				createdAt: "2026-08-22T00:00:00.000Z",
				provenance: [{ chatId: "chat_c", messageId: msgId }],
			});
		fs.appendFileSync(LEDGER_FILES.nodes, `${line("m1")}\n${line("m2")}\n`, "utf-8");
		const lines = graphStore.readNodes().filter((n) => n.id === "n_linktest");
		assert.equal(lines.length, 2, "the store returns raw lines, one per append");
		const merged = getGraph(graphStore).nodes.find((n) => n.id === "n_linktest")!;
		assert.equal(merged.statement, "Phrasing m1", "the FIRST line defines the node");
		assert.ok(merged.aliases.includes("Phrasing m2"), "later phrasings join the aliases");
		assert.deepEqual(merged.provenance.map((p) => p.messageId), ["m1", "m2"]);
	});
});

// ─── the snapshot join ───────────────────────────────────────────────────────

describe("graphSnapshot", () => {
	it("joins session titles and per-node sessions off provenance", () => {
		graphStore.rewriteLedgers({ nodes: [], chains: [] });
		const chat = chatStore.createChat("Snapshot fixture");
		createdChats.push(chat.id);
		const line = (id: string, chatId: string) => ({
			id,
			name: id.toUpperCase(),
			statement: `${id} statement`,
			aliases: [] as string[],
			createdAt: "2026-09-30T00:00:00.000Z",
			provenance: [{ chatId, messageId: "m1" }],
		});
		graphStore.appendNode(line("n_a", chat.id));
		graphStore.appendNode(line("n_b", chat.id));
		graphStore.appendNode(line("n_c", "chat_gone"));
		graphStore.appendChain({
			id: "arg_ab",
			premises: ["n_a"],
			conclusion: "n_b",
			createdAt: "2026-09-30T00:00:00.000Z",
			provenance: [{ chatId: chat.id, messageId: "m1" }],
		});
		const snap = graphSnapshot(graphDeps);
		assert.equal(snap.sessions[chat.id], "Snapshot fixture");
		assert.equal(snap.sessions["chat_gone"], undefined, "a gone record is not labeled");
		assert.deepEqual(snap.nodeSessions["n_a"], [chat.id]);
		assert.equal(snap.nodeSessions["n_c"], undefined, "unresolvable sources are filtered");
		assert.equal("fileSources" in snap, false);
		assert.deepEqual(snap.edges, [{ from: "n_a", to: "n_b" }], "a single-premise chain collapses to one arrow");
		assert.equal(snap.propositions.length, 3);
	});
});

// ─── single-node deletion (node interlude, full death) ───────────────────────

describe("single-node deletion (deleteNodeTraces + deleteGraphNode, node interlude)", () => {
	/** The full-death scenario: node X is born in a notes file (EMPTY
	 *  provenance — a legacy line; the mappings anchor is gone, owner
	 *  2026-09-29), re-encountered by a chat (link line: alias +
	 *  provenance), and asserted in chains by two sessions. */
	function buildNodeScenario() {
		// Clean slate per test: each test in this describe builds its own
		// scenario from empty ledgers (the suite's isolation covers the
		// whole file; this covers describe-internal stacking).
		graphStore.rewriteLedgers({ nodes: [], chains: [] });
		graphStore.writePositions({});
		graphStore.appendNode({
			id: "n_dead",
			name: "Doomed",
			statement: "Doomed statement",
			aliases: [],
			createdAt: "2026-09-23T00:00:00.000Z",
			provenance: [],
		});
		// The chat's re-encounter: a link line (alias + its own provenance).
		graphStore.appendNode({
			id: "n_dead",
			name: "Doomed",
			statement: "Doomed statement",
			aliases: ["doomed, rephrased"],
			createdAt: "2026-09-23T00:00:00.000Z",
			provenance: [{ chatId: "chat_node_a", messageId: "m1" }],
		});
		// A neighbor + two edges: only the one touching X dies.
		graphStore.appendNode({
			id: "n_keep",
			name: "Keeper",
			statement: "Keeper statement",
			aliases: [],
			createdAt: "2026-09-23T00:00:00.000Z",
			provenance: [{ chatId: "chat_node_a", messageId: "m2" }],
		});
		graphStore.appendChain({ id: "arg_dead_keep", premises: ["n_dead"], conclusion: "n_keep", createdAt: "2026-09-23T00:00:00.000Z", provenance: [{ chatId: "chat_node_a", messageId: "m1" }] });
		graphStore.appendChain({ id: "arg_keep_dead", premises: ["n_keep"], conclusion: "n_dead", createdAt: "2026-09-23T00:00:00.000Z", provenance: [{ chatId: "chat_node_b", messageId: "m3" }] });
		// A FOREIGN chain the deletion must not touch (destructive rewriting
		// may not exceed the blast radius — foreign data rides untouched).
		graphStore.appendChain({ id: "arg_keep_other", premises: ["n_keep"], conclusion: "n_other", createdAt: "2026-09-23T00:00:00.000Z", provenance: [{ chatId: "chat_node_b", messageId: "m3" }] });
		// Resting positions for both nodes and both dying chains' imp nodes.
		graphStore.writePositions({ n_dead: { x: 1, y: 1 }, n_keep: { x: 2, y: 2 }, arg_dead_keep: { x: 1.5, y: 1.5 }, arg_keep_dead: { x: 2.5, y: 2.5 } });
	}

	it("deleteNodeTraces: FULL DEATH — the node, its edges, its evidence, its anchors, its position", () => {
		buildNodeScenario();
		const keepLineBefore = JSON.stringify(graphStore.readNodes().find((n) => n.id === "n_keep"));
		const stats = deleteNodeTraces(graphStore, "n_dead");
		assert.deepEqual(stats, { chainsRemoved: 2 } satisfies NodeDeletionStats);

		// The node's EVERY line is gone; the neighbor is byte-identical
		// (full death is node-scoped — other nodes' sessions keep their
		// aliases and provenance).
		assert.equal(graphStore.readNodes().some((n) => n.id === "n_dead"), false);
		assert.equal(
			JSON.stringify(graphStore.readNodes().find((n) => n.id === "n_keep")),
			keepLineBefore,
			"the untouched node is byte-identical",
		);
		// Only the chains referencing X died; the foreign chain stays.
		assert.deepEqual(
			graphStore.readChains().map((c) => [c.premises, c.conclusion]),
			[[["n_keep"], "n_other"]],
		);
		// The resting position died with the node.
		const positions = graphStore.readPositions();
		assert.equal(positions["n_dead"], undefined);
		assert.deepEqual(positions["n_keep"], { x: 2, y: 2 });
		assert.equal(positions["arg_dead_keep"], undefined, "the dying chains' imp-node positions die too");
		assert.equal(positions["arg_keep_dead"], undefined);
		// Atomic rewrites left no temp files.
		assert.equal(fs.readdirSync(PATHS.graph).filter((f) => f.includes(".tmp-")).length, 0);
		// Idempotent: a second run finds no node — null.
		assert.equal(deleteNodeTraces(graphStore, "n_dead"), null);
	});

	it("deleteNodeTraces: a node nothing references still dies, and only its file moves", () => {
		graphStore.appendNode({
			id: "n_solo",
			name: "Solo",
			statement: "Solo statement",
			aliases: [],
			createdAt: "2026-09-23T00:00:00.000Z",
			provenance: [{ chatId: "chat_node_solo", messageId: "m1" }],
		});
		const stats = deleteNodeTraces(graphStore, "n_solo");
		assert.deepEqual(stats, { chainsRemoved: 0 } satisfies NodeDeletionStats);
		assert.equal(graphStore.readNodes().some((n) => n.id === "n_solo"), false);
	});

	it("deleteGraphNode: the orchestration — 404, success", () => {
		// 404 — unknown node.
		assert.deepEqual(deleteGraphNode("n_missing_node"), {
			ok: false,
			status: 404,
			code: "not_found",
			error: "No such node",
		});

		// Success — the node dies, the version stamp moves.
		graphStore.appendNode({
			id: "n_orch",
			name: "Orchestrated",
			statement: "Orchestrated statement",
			aliases: [],
			createdAt: "2026-09-23T00:00:00.000Z",
			provenance: [{ chatId: "chat_node_c", messageId: "m1" }],
		});
		const revisionBefore = graphRevision();
		const outcome = deleteGraphNode("n_orch");
		assert.ok(outcome.ok);
		assert.deepEqual(outcome.stats, { chainsRemoved: 0 });
		assert.ok(outcome.graphRevision > 0);
		assert.ok(outcome.graphRevision >= revisionBefore, "the version stamp moved");
		assert.equal(graphStore.readNodes().some((n) => n.id === "n_orch"), false);
		// And a second call is an honest 404.
		assert.deepEqual(deleteGraphNode("n_orch"), { ok: false, status: 404, code: "not_found", error: "No such node" });
	});
});

// ─── deriveView (the rendering arc, owner 2026-09-30) ────────────────────────

describe("deriveView (the argument's geometry)", () => {
	const prop = (id: string): GraphNode => ({
		id,
		name: id.toUpperCase(),
		statement: `${id} statement`,
		aliases: [],
		createdAt: "2026-09-30T00:00:00.000Z",
		provenance: [],
	});
	const chain = (id: string, premises: string[], conclusion: string): GraphChain => ({
		id,
		premises,
		conclusion,
		provenance: [],
		createdAt: "2026-09-30T00:00:00.000Z",
	});

	it("a SINGLE-premise chain collapses to ONE direct arrow — no imp node", () => {
		const view = deriveView({ nodes: [prop("a"), prop("b")], chains: [chain("arg_ab", ["a"], "b")] });
		assert.deepEqual(view.nodes.map((n) => n.id), ["a", "b"], "no arg_ node minted");
		assert.deepEqual(view.edges, [{ from: "a", to: "b" }], "the argument IS a plain arrow");
	});

	it("a MULTI-premise chain keeps the imp node + fan (premises in, conclusion out)", () => {
		const view = deriveView({
			nodes: [prop("a"), prop("b"), prop("c")],
			chains: [chain("arg_ab", ["a", "b"], "c")],
		});
		assert.deepEqual(view.nodes.map((n) => n.id).sort(), ["a", "arg_ab", "b", "c"]);
		assert.deepEqual(
			[...view.edges].sort((x, y) => (x.from < y.from ? -1 : x.from > y.from ? 1 : x.to < y.to ? -1 : 1)),
			[
				{ from: "a", to: "arg_ab" },
				{ from: "arg_ab", to: "c" },
				{ from: "b", to: "arg_ab" },
			],
		);
		const imp = view.nodes.find((n) => n.id === "arg_ab")!;
		assert.equal(imp.name, "\u27f9");
	});

	it("two chains SHARING a conclusion stay distinct — two geometry points, never a unioned fan", () => {
		const view = deriveView({
			nodes: [prop("a"), prop("b"), prop("c"), prop("d"), prop("e")],
			chains: [chain("arg_e1", ["a", "b"], "e"), chain("arg_e2", ["c", "d"], "e")],
		});
		assert.deepEqual(
			view.nodes.map((n) => n.id).sort(),
			["a", "arg_e1", "arg_e2", "b", "c", "d", "e"],
		);
		assert.ok(view.edges.some((x) => x.from === "arg_e1" && x.to === "e"));
		assert.ok(view.edges.some((x) => x.from === "arg_e2" && x.to === "e"));
	});

	it("dangling chains drop (missing member — the honest belt)", () => {
		const view = deriveView({ nodes: [prop("a")], chains: [chain("arg_ghost", ["a"], "gone"), chain("arg_gone", ["ghost"], "a")] });
		assert.deepEqual(view.nodes.map((n) => n.id), ["a"]);
		assert.deepEqual(view.edges, []);
	});

	it("LOGICAL edges: every chain contracts to direct premise→conclusion arrows (all chains, deduped)", () => {
		const view = deriveView({
			nodes: [prop("a"), prop("b"), prop("c")],
			chains: [chain("arg_ab", ["a", "b"], "c"), chain("arg_ac", ["a"], "c")],
		});
		// arg_ab: a→c AND b→c; arg_ac: a→c again → deduped to one arrow.
		assert.deepEqual(
			[...view.logicalEdges].sort((x, y) => (x.from < y.from ? -1 : x.from > y.from ? 1 : x.to < y.to ? -1 : 1)),
			[
				{ from: "a", to: "c" },
				{ from: "b", to: "c" },
			],
		);
		// Proposition ids only — no arg_ endpoint ever rides the logical set.
		assert.ok(view.logicalEdges.every((e) => !e.from.startsWith("arg_") && !e.to.startsWith("arg_")));
	});

	it("impLinks: one linkage per MULTI-premise chain — the depth pass's midpoint input", () => {
		const view = deriveView({
			nodes: [prop("a"), prop("b"), prop("c")],
			chains: [chain("arg_ab", ["a", "b"], "c"), chain("arg_ac", ["a"], "c")],
		});
		assert.deepEqual(view.impLinks, [{ id: "arg_ab", premises: ["a", "b"], conclusion: "c" }]);
	});
});
