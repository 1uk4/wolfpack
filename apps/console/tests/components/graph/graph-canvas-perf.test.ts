/**
 * Graph load/frame cost guards, driven through the real GraphCanvasRenderer on a recording canvas:
 * physics tuning is compared by value (no startup re-anneal), sim frames don't re-measure labels.
 */
import { zoomIdentity } from "d3-zoom";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const counts = { measureText: 0, fillText: 0 };
const mkCtx = (): any =>
	new Proxy({}, {
		get: (_t, p) =>
			p === "canvas" ? {} :
			p === "measureText" ? () => (counts.measureText++, { width: 10 }) :
			p === "fillText" ? () => void counts.fillText++ :
			p === "getImageData" || p === "createImageData" ? (...a: number[]) => ({ data: new Uint8ClampedArray(4 * (a[2] ?? a[0]!) * (a[3] ?? a[1]!)) }) :
			p === "createRadialGradient" || p === "createLinearGradient" ? () => ({ addColorStop() {} }) :
			() => {},
		set: () => true,
	});
const canvas: any = {
	getContext: () => mkCtx(), addEventListener() {}, removeEventListener() {}, style: { setProperty() {} }, nodeName: "CANVAS",
	clientWidth: 800, clientHeight: 600, width: 800, height: 600,
	getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
};
let frames: Array<() => void> = [];
Object.assign(globalThis, {
	window: { devicePixelRatio: 1, matchMedia: () => ({ matches: false }), addEventListener() {} },
	document: { createElement: () => ({ width: 0, height: 0, getContext: () => mkCtx() }) },
	SVGElement: class {},
	ResizeObserver: class { observe() {} disconnect() {} },
	requestAnimationFrame: (f: () => void) => (frames.push(f), frames.length),
	cancelAnimationFrame: () => {},
	Path2D: class { moveTo() {} lineTo() {} arc() {} closePath() {} },
});
const pump = async (n = 12) => {
	for (let i = 0; i < n; i++) {
		await new Promise((r) => setTimeout(r, 5));
		const f = frames;
		frames = [];
		f.forEach((x) => x());
	}
};

async function setup(count = 3, view = { k: 1, x: 400, y: 300 }) {
	const { GraphCanvasRenderer } = await import("../../../components/graph/graph-canvas.ts");
	const r: any = new GraphCanvasRenderer(canvas, { onSelect() {}, onStageClick() {}, onCommit() {}, onCameraMove() {} } as any, view);
	const nodes = Array.from({ length: count }, (_, i) => ({ id: `n${i}`, x: (i % 10) * 300 - 1200, y: Math.floor(i / 10) * 300, label: `node ${i}` }));
	r.setSettings({ nodeSize: 6, labelSize: 10, labelZoom: 8, edgeWidth: 1, clusterLabels: true });
	r.setData({
		nodes, edges: nodes.slice(1).map((n, i) => ({ from: nodes[i]!.id, to: n.id })), depEdges: [], depSprings: [], clusters: [],
		subClusters: [{ id: "x", label: null, members: nodes.map((n) => n.id), color: "#fff" }],
		colors: { node: "#fff", edge: "#aaa", label: "#bbb", hoverText: "#ccc" }, fontFamily: "x",
	});
	// The first load always fits (work-wolfpack-2wEvr00) and replaces the stored camera; these tests assume the given view, so set it after the fit.
	r.transform = zoomIdentity.translate(view.x, view.y).scale(view.k);
	await pump();
	return r;
}

describe("graph load and frame cost", () => {
	beforeEach(() => {
		counts.measureText = 0;
		counts.fillText = 0;
		frames = [];
	});

	it("live sim frames do not re-measure labels", async () => {
		const r = await setup(20);
		const measured = counts.measureText;
		assert.ok(measured >= 20, "labels were wrapped once at build");
		r.sim.alpha(1);
		r.simActive = true;
		r.markDirty();
		const before = r.geoVersion;
		await pump(8);
		assert.ok(r.geoVersion - before >= 3, "the sim ticked several frames");
		assert.equal(counts.measureText, measured);
		r.destroy();
	});

	it("labels are drawn only for nodes near the viewport", async () => {
		// 20 nodes at world x -1200..1500 step 300 (two rows of 10 do not apply: y = 0 for all). View k=1 shows world x -400..400.
		const r = await setup(10, { k: 1, x: 400, y: 300 });
		counts.fillText = 0;
		r.markDirty();
		await pump(2);
		const labels = counts.fillText;
		assert.ok(labels > 0, "visible labels are drawn");
		// nodes sit at x=-1200,-900,-600,-300,0,300,600,900,1200,1500; margin 150px keeps -600..600 at most (one node per line label)
		assert.ok(labels <= 5, `only nearby labels drawn, got ${labels}`);
		r.destroy();
	});

	it("a refetch with identical content keeps the sim; a changed node rebuilds it", async () => {
		const r = await setup(5);
		const sim = r.sim;
		const copy = JSON.parse(JSON.stringify(r.data));
		r.setData(copy);
		assert.equal(r.sim, sim, "equal payload: no rebuild");
		const changed = JSON.parse(JSON.stringify(r.data));
		changed.nodes[0].label = "renamed";
		r.setData(changed);
		assert.notEqual(r.sim, sim, "changed payload: rebuilt");
		r.destroy();
	});

	it("settings that load with the same physics values neither rebuild the sim nor reheat it; a real change does", async () => {
		const { DEFAULT_PHYSICS_TUNING } = await import("../../../src/core/graph/render-settings.ts");
		const r = await setup();
		const sim = r.sim;
		const settled = sim.alpha();
		r.setPhysicsTuning(DEFAULT_PHYSICS_TUNING);
		r.setPhysicsTuning({ ...DEFAULT_PHYSICS_TUNING });
		assert.equal(r.sim, sim, "same sim object");
		assert.equal(r.sim.alpha(), settled, "no reheat");
		r.setPhysicsTuning({ ...DEFAULT_PHYSICS_TUNING, gravity: DEFAULT_PHYSICS_TUNING.gravity + 0.05 });
		assert.equal(r.sim.alpha(), 1, "a real change reheats");
		r.destroy();
	});
});
