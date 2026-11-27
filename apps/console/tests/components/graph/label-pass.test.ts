/** The label pass on a fake canvas (work-wolfpack-Wu0RH2z): what it draws, what it measures, and what a changed filter or setting does. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LabelPass, type LabelFrame, type LabelNode } from "../../../components/graph/label-pass.ts";
import { stepLabelFades } from "../../../src/core/graph/label-lod.ts";

function fakeCtx() {
	const drawn: { text: string; font: string }[] = [];
	let measured = 0;
	const st = { font: "", fillStyle: "", textAlign: "", textBaseline: "" };
	const ctx = Object.assign(st, {
		save: () => undefined,
		restore: () => undefined,
		measureText: (t: string) => ((measured += 1), { width: t.length * 50 }),
		fillText: (text: string) => void drawn.push({ text, font: st.font }),
	}) as unknown as CanvasRenderingContext2D;
	return { ctx, drawn, measured: () => measured };
}

const nodes = new Map<string, LabelNode>([
	["dom", { id: "dom", x: 100, y: 100, label: "Domain" }],
	["leaf1", { id: "leaf1", x: 300, y: 100, label: "Leaf one" }],
	["leaf2", { id: "leaf2", x: 500, y: 300, label: "Leaf two" }],
]);

function setup() {
	const pass = new LabelPass();
	pass.setHierarchy(
		nodes.keys(),
		[{ from: "dom", to: "leaf1" }, { from: "dom", to: "leaf2" }],
		new Map([["dom", 0], ["leaf1", 2], ["leaf2", 2]]),
	);
	const c = fakeCtx();
	let now = 1000;
	const frame = (over: Partial<LabelFrame> = {}): LabelFrame => ({
		ctx: c.ctx, tx: 0, ty: 0, k: 1, w: 1000, h: 800, ze: 1, on: true, hoverId: null, selectedId: null, reduce: true, privateView: false,
		textColor: "#ffffff", fontFamily: "sans-serif", nodes, radiusOf: () => 4, visible: null, groups: [], geoVersion: 1, now: (now += 16),
		clusterLabels: true, clusterScale: 1, ...over,
	});
	/** Draw one frame and answer the texts it painted. */
	const shown = (over: Partial<LabelFrame> = {}) => {
		c.drawn.length = 0;
		pass.draw(frame(over));
		return c.drawn.map((d) => d.text).sort();
	};
	return { pass, c, shown };
}

describe("label pass", () => {
	it("zoomed out only the domain is labelled; zoomed in the leaves join it", () => {
		const s = setup();
		assert.deepEqual(s.shown({ ze: 1 }), ["Domain"]);
		assert.deepEqual(s.shown({ ze: 3 }), ["Domain", "Leaf one", "Leaf two"]);
	});

	it("with Labels off only the hovered and selected labels (and their parent chain) show", () => {
		const s = setup();
		assert.deepEqual(s.shown({ ze: 3, on: false }), []);
		assert.deepEqual(s.shown({ ze: 3, on: false, hoverId: "leaf1" }), ["Domain", "Leaf one"]);
	});

	it("labels not eligible at this zoom are never measured, and a frame that only moves the camera measures nothing", () => {
		const s = setup();
		s.shown({ ze: 1 });
		const first = s.c.measured();
		assert.equal(first, 1, "only the domain was eligible");
		s.shown({ ze: 1, tx: 5 });
		s.shown({ ze: 1, tx: 9 });
		assert.equal(s.c.measured(), first);
		s.shown({ ze: 3 });
		assert.equal(s.c.measured(), first + 2, "the two leaves, once");
		s.shown({ ze: 3, tx: 4 });
		assert.equal(s.c.measured(), first + 2);
	});

	it("a search filter changes what is drawn even when the camera and geometry did not move", () => {
		const s = setup();
		assert.deepEqual(s.shown({ ze: 3 }), ["Domain", "Leaf one", "Leaf two"]);
		assert.deepEqual(s.shown({ ze: 3, visible: new Set(["leaf2"]) }), ["Leaf two"]);
		assert.deepEqual(s.shown({ ze: 3, visible: new Set(["leaf1", "leaf2"]) }), ["Leaf one", "Leaf two"]);
	});

	it("cluster labels off hides the domain title but not a hovered one; the size setting scales it", () => {
		const s = setup();
		assert.deepEqual(s.shown({ ze: 3, clusterLabels: false }), ["Leaf one", "Leaf two"]);
		assert.deepEqual(s.shown({ ze: 3, clusterLabels: false, hoverId: "dom" }), ["Domain", "Leaf one", "Leaf two"]);
	});

	it("the cluster label size scales the domain title's font, not the leaves'", () => {
		const s = setup();
		s.shown({ ze: 3, clusterScale: 2 });
		const font = (t: string) => s.c.drawn.find((d) => d.text === t)!.font;
		assert.match(font("Domain"), /30px/);
		assert.match(font("Leaf one"), /11px/);
	});
});

describe("label fades", () => {
	it("fade toward shown or hidden over time, and jump at once under reduced motion", () => {
		const fades = new Map<string, number>([["gone", 0.5]]);
		assert.equal(stepLabelFades(fades, new Set(["a"]), 80, false), true);
		assert.ok(Math.abs(fades.get("a")! - 0.5) < 1e-9, "half a fade after half the duration");
		assert.ok(Math.abs(fades.get("gone")! - 0) < 1e-9 || !fades.has("gone"));
		const snap = new Map<string, number>([["gone", 0.5]]);
		assert.equal(stepLabelFades(snap, new Set(["a"]), 1, true), false);
		assert.deepEqual([...snap], [["a", 1]]);
	});
});
