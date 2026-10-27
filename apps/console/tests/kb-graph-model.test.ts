/**
 * The KB graph model (src/core/kb-graph-model.ts): domain colours, node
 * styles, glow groups, canvas mapping, search, cards, the focus param.
 * Pure — no DOM.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DOMAIN_PALETTE,
	NEUTRAL_NODE_COLOR,
	PINNED_DOMAIN_SLOTS,
	WORK_RING_WEIGHT,
	depthOf,
	describeNode,
	domainColors,
	domainHue,
	focusRemedy,
	focusStep,
	groupClusters,
	hashString,
	isNodeVisible,
	nodeStyle,
	normalizeHex,
	parseFocusParam,
	toCanvasData,
	visibleNodeIds,
} from "../src/core/kb-graph-model.ts";
import type { KbGraph, KbGraphNode } from "../src/core/kb.ts";

const node = (n: Partial<KbGraphNode> & Pick<KbGraphNode, "id" | "kind">): KbGraphNode => ({
	label: n.id,
	depth: ({ domain: 0, section: 1, entry: 2, work: 3, "den-topic": 4 } as const)[n.kind],
	...n,
});

/** Two domains; wolfpack has a section tree, an entry-less orphan entry, work, a den topic. */
function fixture(): KbGraph {
	return {
		nodes: [
			node({ id: "dom:wolfpack", kind: "domain", label: "Wolfpack", domain: "wolfpack" }),
			node({ id: "dom:snapjack", kind: "domain", label: "Snapjack", domain: "snapjack" }),
			node({ id: "sec:arch", kind: "section", label: "Architecture", domain: "wolfpack", sectionId: "arch", summary: "How it fits" }),
			node({ id: "sec:arch-sub", kind: "section", label: "Memory", domain: "wolfpack", sectionId: "arch-sub" }),
			node({ id: "ent:e1", kind: "entry", label: "Entry one", domain: "wolfpack", sectionId: "arch", summary: "First", maturity: "stable", entryKind: "decision" }),
			node({ id: "ent:e2", kind: "entry", label: "Entry two", domain: "wolfpack", sectionId: "arch-sub" }),
			node({ id: "ent:orphan", kind: "entry", label: "Orphan", domain: "wolfpack" }),
			node({ id: "ent:s1", kind: "entry", label: "Snap entry", domain: "snapjack" }),
			node({ id: "work:w1", kind: "work", label: "Feature", domain: "wolfpack", stage: "in_build", workKind: "feature" }),
			node({ id: "work:w2", kind: "work", label: "Task", domain: "wolfpack", stage: "plan", workKind: "task", assignee: "1uk4" }),
			node({ id: "work:w3", kind: "work", label: "Old", domain: "wolfpack", stage: "archived" }),
			node({ id: "den:hal:t1", kind: "den-topic", label: "Topic", wolf: "hal", promotable: false, summary: "private" }),
			node({ id: "den:hal:t2", kind: "den-topic", label: "Topic 2", wolf: "hal" }),
		],
		edges: [
			{ source: "dom:wolfpack", target: "sec:arch", kind: "hierarchy" },
			{ source: "sec:arch", target: "sec:arch-sub", kind: "hierarchy" },
			{ source: "sec:arch", target: "ent:e1", kind: "hierarchy" },
			{ source: "sec:arch-sub", target: "ent:e2", kind: "hierarchy" },
			{ source: "dom:wolfpack", target: "ent:orphan", kind: "hierarchy" },
			{ source: "work:w2", target: "work:w1", kind: "partOf" },
			{ source: "work:w2", target: "work:w3", kind: "dependsOn" },
			{ source: "ent:e1", target: "ent:e2", kind: "related", relation: "see_also" },
			{ source: "ent:orphan", target: "ent:e1", kind: "related", relation: "refines" },
			{ source: "ent:e1", target: "ent:e2", kind: "wikilink" },
			{ source: "ent:e1", target: "ent:missing", kind: "wikilink" },
			{ source: "ent:e1", target: "ent:e1", kind: "related" },
			{ source: "dom:wolfpack", target: "sec:arch", kind: "hierarchy" },
		],
		layers: { archivedWork: true, wikilinks: true, denTopics: true },
		domain: null,
		domains: [
			{ name: "wolfpack", label: "Wolfpack" },
			{ name: "snapjack", label: "Snapjack", color: "#ABCDEF" },
		],
		generated: "2026-10-27T00:00:00.000Z",
	};
}

describe("domainHue", () => {
	it("is stable: pinned domains take their palette slot, unknown ones a hash hue", () => {
		assert.equal(domainHue("wolfpack"), DOMAIN_PALETTE[PINNED_DOMAIN_SLOTS.wolfpack!]);
		assert.equal(domainHue("snapjack"), DOMAIN_PALETTE[PINNED_DOMAIN_SLOTS.snapjack!]);
		const a = domainHue("research");
		assert.equal(domainHue("research"), a, "same name, same colour");
		assert.match(a, /^#[0-9a-f]{6}$/);
		assert.notEqual(domainHue("research"), domainHue("finance"), "different names differ");
	});

	it("does not depend on which other domains exist (no order effects)", () => {
		const alone = domainColors({ domains: [{ name: "alpha", label: "a" }], nodes: [] }).get("alpha");
		const crowd = domainColors({ domains: [{ name: "zeta", label: "z" }, { name: "alpha", label: "a" }, { name: "wolfpack", label: "w" }], nodes: [] }).get("alpha");
		assert.equal(alone, crowd);
	});

	it("the payload override wins and is normalised; a bad override falls back", () => {
		assert.equal(domainHue("wolfpack", "#ABCDEF"), "#abcdef");
		assert.equal(domainHue("wolfpack", "#fa0"), "#ffaa00");
		assert.equal(domainHue("wolfpack", "red"), DOMAIN_PALETTE[0]);
		assert.equal(domainHue("wolfpack", null), DOMAIN_PALETTE[0]);
	});

	it("domainColors applies overrides and covers domains only nodes mention", () => {
		const colors = domainColors(fixture());
		assert.equal(colors.get("snapjack"), "#abcdef");
		assert.equal(colors.get("wolfpack"), DOMAIN_PALETTE[0]);
		const extra = domainColors({ domains: [], nodes: [node({ id: "ent:x", kind: "entry", domain: "ghost" })] });
		assert.equal(extra.get("ghost"), domainHue("ghost"));
	});

	it("the palette is large and distinct; hash and hex helpers behave", () => {
		assert.ok(DOMAIN_PALETTE.length >= 16);
		assert.equal(new Set(DOMAIN_PALETTE).size, DOMAIN_PALETTE.length);
		assert.equal(hashString("a"), hashString("a"));
		assert.notEqual(hashString("a"), hashString("b"));
		assert.equal(normalizeHex("#FFF"), "#ffffff");
		assert.equal(normalizeHex("ffffff"), null);
		assert.equal(normalizeHex(5), null);
	});
});

describe("nodeStyle (kind by size and style)", () => {
	const style = (kind: KbGraphNode["kind"], stage?: string) => nodeStyle({ kind, stage });

	it("domains largest, then sections, then entries, den topics smallest", () => {
		const r = (k: KbGraphNode["kind"]) => style(k).radius;
		assert.ok(r("domain") > r("section") && r("section") > r("entry") && r("entry") > r("den-topic"));
	});

	it("entries and sections are filled discs; work items are hollow rings", () => {
		assert.equal(style("entry").shape, "disc");
		assert.equal(style("section").shape, "disc");
		assert.equal(style("domain").shape, "disc");
		assert.equal(style("work", "plan").shape, "ring");
		assert.ok(style("work", "plan").ring > 0);
		assert.equal(style("entry").ring, 0);
	});

	it("work outline weight grows with the stage; archived work is the lightest and dimmed", () => {
		const w = (stage: string) => style("work", stage).ring;
		assert.ok(w("idea") < w("plan") && w("plan") < w("approved") && w("approved") < w("in_build"));
		assert.ok(w("in_build") < w("shipped") && w("shipped") < w("live"));
		assert.equal(style("work", "archived").dim, true);
		assert.equal(style("work", "in_build").dim, false);
		assert.ok(w("archived") <= w("idea"));
		assert.equal(Object.keys(WORK_RING_WEIGHT).length, 8);
		assert.ok(style("work", "weird-stage").ring > 0, "unknown stage still gets a ring");
		assert.ok(style("work", undefined).ring > 0);
	});

	it("den topics are dimmed; nothing else is", () => {
		assert.equal(style("den-topic").dim, true);
		assert.equal(style("entry").dim, false);
		assert.equal(style("domain").dim, false);
	});

	it("domains label only after zooming further in than entries", () => {
		assert.ok(style("domain").labelGate < style("entry").labelGate);
		assert.equal(style("entry").labelGate, 1);
	});
});

describe("depthOf", () => {
	it("follows the payload hierarchy; falls back to the kind", () => {
		assert.deepEqual(
			(["domain", "section", "entry", "work", "den-topic"] as const).map((kind) => depthOf({ kind, depth: undefined as unknown as 0 })),
			[0, 1, 2, 3, 4],
		);
		assert.equal(depthOf({ kind: "entry", depth: 3 }), 3);
		assert.equal(depthOf({ kind: "entry", depth: 99 as unknown as 4 }), 4, "clamped");
		assert.equal(depthOf({ kind: "work", depth: Number.NaN as unknown as 3 }), 3);
	});
});

describe("groupClusters", () => {
	const g = fixture();
	const ids = (cs: ReturnType<typeof groupClusters>) => cs.map((c) => c.id);

	it("by domain: one region per domain plus one per wolf's den", () => {
		const cs = groupClusters(g, "domain");
		assert.deepEqual(ids(cs), ["den:hal", "dom:snapjack", "dom:wolfpack"]);
		const wolfpack = cs.find((c) => c.id === "dom:wolfpack")!;
		assert.equal(wolfpack.label, "Wolfpack");
		assert.ok(wolfpack.members.includes("dom:wolfpack") && wolfpack.members.includes("ent:e1") && wolfpack.members.includes("work:w1"));
		assert.ok(!wolfpack.members.includes("den:hal:t1"), "den topics stay out of domain groups");
		assert.equal(cs.find((c) => c.id === "den:hal")!.color, NEUTRAL_NODE_COLOR);
	});

	it("by section: sections own their entries; the rest stays with the domain", () => {
		const cs = groupClusters(g, "section");
		assert.deepEqual(ids(cs), ["den:hal", "dom:snapjack", "dom:wolfpack", "sec:arch", "sec:arch-sub"]);
		assert.deepEqual(cs.find((c) => c.id === "sec:arch")!.members.sort(), ["ent:e1", "sec:arch"]);
		assert.deepEqual(cs.find((c) => c.id === "sec:arch-sub")!.members.sort(), ["ent:e2", "sec:arch-sub"]);
		const dom = cs.find((c) => c.id === "dom:wolfpack")!;
		assert.ok(["dom:wolfpack", "ent:orphan", "work:w1", "work:w2", "work:w3"].every((m) => dom.members.includes(m)));
		assert.equal(cs.find((c) => c.id === "sec:arch")!.label, "Architecture");
	});

	it("regions take the domain's hue (override included), matching node fill", () => {
		const colors = domainColors(g);
		for (const mode of ["domain", "section"] as const) {
			for (const c of groupClusters(g, mode)) {
				if (c.id.startsWith("den:")) continue;
				const members = g.nodes.filter((n) => c.members.includes(n.id));
				assert.ok(members.every((m) => colors.get(m.domain!) === c.color), `${mode} ${c.id}`);
			}
		}
	});

	it("groups under two members are dropped; output is sorted and deterministic", () => {
		const cs = groupClusters(
			{ domains: [], nodes: [node({ id: "dom:solo", kind: "domain", domain: "solo" }), node({ id: "ent:a", kind: "entry", domain: "b" }), node({ id: "ent:b", kind: "entry", domain: "b" })] },
			"domain",
		);
		assert.deepEqual(ids(cs), ["dom:b"]);
		assert.deepEqual(groupClusters(g, "domain"), groupClusters(g, "domain"));
	});

	it("an entry naming a section the payload lacks falls back to its domain", () => {
		const cs = groupClusters(
			{ domains: [], nodes: [node({ id: "ent:a", kind: "entry", domain: "d", sectionId: "gone" }), node({ id: "ent:b", kind: "entry", domain: "d" })] },
			"section",
		);
		assert.deepEqual(ids(cs), ["dom:d"]);
	});
});

describe("toCanvasData", () => {
	const data = toCanvasData(fixture(), { groupBy: "domain" });

	it("every node carries its domain colour, style and label", () => {
		const e1 = data.nodes.find((n) => n.id === "ent:e1")!;
		assert.equal(e1.color, DOMAIN_PALETTE[0]);
		assert.equal(e1.shape, "disc");
		assert.equal(e1.label, "Entry one");
		assert.equal(data.nodes.find((n) => n.id === "ent:s1")!.color, "#abcdef", "override flows to nodes");
		assert.equal(data.nodes.find((n) => n.id === "den:hal:t1")!.color, NEUTRAL_NODE_COLOR);
		const w1 = data.nodes.find((n) => n.id === "work:w1")!;
		assert.equal(w1.shape, "ring");
		assert.equal(w1.ring, WORK_RING_WEIGHT.in_build);
	});

	it("edges: dangling ends, self loops and duplicates are dropped; soft links are faint", () => {
		assert.equal(data.edges.length, 10);
		assert.ok(!data.edges.some((e) => e.to === "ent:missing" || e.from === e.to));
		assert.equal(data.edges.filter((e) => e.from === "dom:wolfpack" && e.to === "sec:arch").length, 1);
		const faint = data.edges.filter((e) => e.faint);
		assert.equal(faint.length, 3, "two related + one wikilink");
		assert.equal(data.edges.filter((e) => !e.faint).length, 7, "structure edges stay solid");
	});

	it("depths follow the hierarchy; clusters follow groupBy", () => {
		assert.equal(data.depths.get("dom:wolfpack"), 0);
		assert.equal(data.depths.get("sec:arch"), 1);
		assert.equal(data.depths.get("ent:e1"), 2);
		assert.equal(data.depths.get("work:w1"), 3);
		assert.equal(data.depths.get("den:hal:t1"), 4);
		assert.deepEqual(data.clusters.map((c) => c.id), ["den:hal", "dom:snapjack", "dom:wolfpack"]);
		assert.ok(toCanvasData(fixture(), { groupBy: "section" }).clusters.some((c) => c.id === "sec:arch"));
	});

	it("duplicate node ids collapse to the first", () => {
		const g = fixture();
		g.nodes.push({ ...g.nodes[0]!, label: "dup" });
		assert.equal(toCanvasData(g, { groupBy: "domain" }).nodes.filter((n) => n.id === "dom:wolfpack").length, 1);
	});
});

describe("search", () => {
	const g = fixture();
	it("empty query matches everything; matching is case-insensitive over label/id/summary/domain/stage", () => {
		assert.equal(visibleNodeIds(g.nodes, "  ").size, g.nodes.length);
		assert.deepEqual([...visibleNodeIds(g.nodes, "ENTRY ONE")], ["ent:e1"]);
		assert.ok(visibleNodeIds(g.nodes, "snapjack").has("ent:s1"));
		assert.ok(visibleNodeIds(g.nodes, "in_build").has("work:w1"));
		assert.ok(visibleNodeIds(g.nodes, "how it fits").has("sec:arch"));
		assert.ok(visibleNodeIds(g.nodes, "e1").has("ent:e1"), "ids match too");
		assert.equal(visibleNodeIds(g.nodes, "zzz").size, 0);
	});
	it("isNodeVisible tolerates absent fields", () => {
		assert.equal(isNodeVisible({ id: "x:1", label: "L" } as KbGraphNode, "l"), true);
		assert.equal(isNodeVisible({ id: "x:1", label: "L" } as KbGraphNode, "nope"), false);
	});
});

describe("describeNode (the detail cards)", () => {
	const g = fixture();

	it("unknown id → null", () => assert.equal(describeNode(g, "ent:nope"), null));

	it("entry: title, summary, domain, section, maturity, related (both directions) + open", () => {
		const c = describeNode(g, "ent:e1")!;
		assert.equal(c.title, "Entry one");
		assert.equal(c.summary, "First");
		assert.deepEqual(c.domain, { name: "wolfpack", label: "Wolfpack" });
		assert.deepEqual(c.section, { id: "sec:arch", label: "Architecture" });
		assert.equal(c.maturity, "stable");
		assert.equal(c.entryKind, "decision");
		assert.deepEqual(c.related.map((r) => [r.id, r.relation]), [["ent:e2", "see_also"], ["ent:orphan", "refines"]]);
		assert.equal(c.openHref, "/kb/entry/e1");
		assert.equal(c.focusIds, undefined);
	});

	it("work: stage, parent, dependencies + open", () => {
		const c = describeNode(g, "work:w2")!;
		assert.equal(c.stage, "plan");
		assert.equal(c.workKind, "task");
		assert.equal(c.assignee, "1uk4");
		assert.deepEqual(c.parent, { id: "work:w1", label: "Feature", kind: "work" });
		assert.deepEqual(c.dependencies.map((d) => d.id), ["work:w3"]);
		assert.equal(c.openHref, "/kb/work/w2");
		const root = describeNode(g, "work:w1")!;
		assert.equal(root.parent, null);
		assert.deepEqual(root.dependencies, []);
	});

	it("section: summary + the ids to focus (itself, its entries, subsections and theirs)", () => {
		const c = describeNode(g, "sec:arch")!;
		assert.equal(c.summary, "How it fits");
		assert.deepEqual(c.focusIds!.sort(), ["ent:e1", "ent:e2", "sec:arch", "sec:arch-sub"]);
		assert.equal(c.openHref, undefined);
		assert.deepEqual(describeNode(g, "sec:arch-sub")!.focusIds!.sort(), ["ent:e2", "sec:arch-sub"]);
	});

	it("den topic: minimal (wolf, promotable, summary)", () => {
		const c = describeNode(g, "den:hal:t1")!;
		assert.equal(c.wolf, "hal");
		assert.equal(c.promotable, false);
		assert.equal(c.summary, "private");
		assert.equal(c.openHref, undefined);
		assert.deepEqual(c.related, []);
	});

	it("domain: counts of what it holds", () => {
		const c = describeNode(g, "dom:wolfpack")!;
		assert.equal(c.counts!.section, 2);
		assert.equal(c.counts!.entry, 3);
		assert.equal(c.counts!.work, 3);
	});

	it("ids are percent-encoded in hrefs", () => {
		const odd: KbGraph = { ...fixture(), nodes: [node({ id: "ent:a/b c", kind: "entry", domain: "d" })], edges: [] };
		assert.equal(describeNode(odd, "ent:a/b c")!.openHref, "/kb/entry/a%2Fb%20c");
	});
});

describe("parseFocusParam", () => {
	it("accepts well-formed node ids from a string or URLSearchParams", () => {
		assert.equal(parseFocusParam("?focus=ent%3Aabc"), "ent:abc");
		assert.equal(parseFocusParam("focus=work:work-wolfpack-X1"), "work:work-wolfpack-X1");
		assert.equal(parseFocusParam(new URLSearchParams({ focus: "den:hal:t1" })), "den:hal:t1");
		assert.equal(parseFocusParam(new URLSearchParams({ focus: "dom:wolfpack" })), "dom:wolfpack");
		assert.equal(parseFocusParam(new URLSearchParams({ focus: "sec:arch" })), "sec:arch");
	});
	it("rejects anything else", () => {
		for (const bad of ["", "?", "?focus=", "?focus=abc", "?focus=ent:", "?focus=evil:1", "?other=ent:1"]) {
			assert.equal(parseFocusParam(bad), null, bad);
		}
		assert.equal(parseFocusParam(null), null);
		assert.equal(parseFocusParam(undefined), null);
		assert.equal(parseFocusParam(`?focus=ent:${"x".repeat(600)}`), null);
	});
});

describe("focusRemedy", () => {
	const view = (o: Partial<{ archivedWork: boolean; denTopics: boolean; domain: string | null }> = {}) => ({
		layers: { archivedWork: o.archivedWork ?? false, wikilinks: false, denTopics: o.denTopics ?? false },
		domain: o.domain ?? null,
	});
	it("work ids ask for archived work, den ids for den topics, a filter for all domains", () => {
		assert.deepEqual(focusRemedy("work:x", view()), { archivedWork: true });
		assert.deepEqual(focusRemedy("den:hal:t", view()), { denTopics: true });
		assert.deepEqual(focusRemedy("ent:x", view({ domain: "wolfpack" })), { allDomains: true });
		assert.deepEqual(focusRemedy("work:x", view({ domain: "wolfpack" })), { archivedWork: true, allDomains: true });
	});
	it("nothing left to widen → null", () => {
		assert.equal(focusRemedy("ent:x", view()), null);
		assert.equal(focusRemedy("work:x", view({ archivedWork: true })), null);
		assert.equal(focusRemedy("den:hal:t", view({ denTopics: true })), null);
	});
});

describe("focusStep (the /?focus= flow)", () => {
	const g = fixture();
	const view = { layers: { archivedWork: false, wikilinks: false, denTopics: false }, domain: null as string | null };
	const base = { focusId: "work:w9", graph: g, settled: true, view };

	it("no param → idle", () => assert.deepEqual(focusStep({ ...base, focusId: null }), { kind: "idle" }));

	it("waits while the graph on screen belongs to an older query (the widened one is in flight)", () => {
		assert.deepEqual(focusStep({ ...base, settled: false }), { kind: "wait" });
		assert.deepEqual(focusStep({ ...base, graph: null }), { kind: "wait" });
	});

	it("present → focus, even from a stale graph's replacement", () => {
		assert.deepEqual(focusStep({ ...base, focusId: "ent:e1" }), { kind: "focus" });
	});

	it("absent from a settled graph → widen once, then (widened and settled) → missing", () => {
		assert.deepEqual(focusStep(base), { kind: "widen", remedy: { archivedWork: true } });
		const widened = { ...view, layers: { ...view.layers, archivedWork: true } };
		assert.deepEqual(focusStep({ ...base, view: widened }), { kind: "missing" });
	});

	it("full flow: widen → wait (refetching) → focus when the widened graph lands", () => {
		const s1 = focusStep(base);
		assert.equal(s1.kind, "widen");
		const widened = { ...view, layers: { ...view.layers, archivedWork: true } };
		assert.equal(focusStep({ ...base, view: widened, settled: false }).kind, "wait");
		const landed = { ...g, nodes: [...g.nodes, node({ id: "work:w9", kind: "work", domain: "wolfpack" })] };
		assert.equal(focusStep({ ...base, graph: landed, view: widened }).kind, "focus");
	});
});
