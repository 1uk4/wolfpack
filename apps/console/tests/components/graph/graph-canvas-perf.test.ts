/**
 * Graph load/frame cost guards, driven through the real GraphCanvasRenderer on a recording canvas:
 * physics tuning is compared by value (no startup re-anneal), sim frames don't re-measure labels.
 */
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
	r.setSettings({ nodeSize: 6, labelSize: 10, labelZoom: 8, edgeWidth: 1 });
	r.setData({
		nodes, edges: nodes.slice(1).map((n, i) => ({ from: nodes[i]!.id, to: n.id })), depEdges: [], depSprings: [], clusters: [],
		subClusters: [{ id: "x", label: null, members: nodes.map((n) => n.id), color: "#fff" }],
		colors: { node: "#fff", edge: "#aaa", label: "#bbb", hoverText: "#ccc" }, fontFamily: "x",
	});
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
