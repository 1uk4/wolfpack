/**
 * Loading a settled layout must not visibly move it. The live sim pulls
 * toward the origin, so an off-centre layout is translated to the origin ONCE
 * on load, the camera shifted by the same offset (same picture on screen) and
 * the new positions committed once; the first drag or reheat then has nothing
 * to pull. A stored camera that was saved while the data was still small is
 * re-checked when the data grows. Drives the real GraphCanvasRenderer on a
 * stubbed canvas.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const ctx: any = new Proxy({}, {
	get: (_t, p) =>
		p === "canvas" ? {} :
		p === "measureText" ? () => ({ width: 10 }) :
		p === "getImageData" || p === "createImageData" ? (...a: number[]) => ({ data: new Uint8ClampedArray(4 * (a[2] ?? a[0]!) * (a[3] ?? a[1]!)) }) :
		p === "createRadialGradient" || p === "createLinearGradient" ? () => ({ addColorStop() {} }) :
		() => {},
	set: () => true,
});
const canvas: any = {
	getContext: () => ctx, addEventListener() {}, removeEventListener() {}, style: { setProperty() {} }, nodeName: "CANVAS",
	clientWidth: 800, clientHeight: 600, width: 800, height: 600,
	getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
};
let frames: Array<() => void> = [];
Object.assign(globalThis, {
	window: { devicePixelRatio: 1, matchMedia: () => ({ matches: false }), addEventListener() {} },
	SVGElement: class {},
	ResizeObserver: class { observe() {} disconnect() {} },
	requestAnimationFrame: (f: () => void) => (frames.push(f), frames.length),
	cancelAnimationFrame: () => {},
	Path2D: class { moveTo() {} lineTo() {} arc() {} closePath() {} },
});
const pump = async () => {
	for (let i = 0; i < 20; i++) {
		await new Promise((r) => setTimeout(r, 15));
		const f = frames;
		frames = [];
		f.forEach((x) => x());
	}
};

const dataOf = (nodes: Array<{ id: string; x: number; y: number; label: string }>) => ({
	nodes, edges: nodes.slice(1).map((n, i) => ({ from: nodes[i]!.id, to: n.id })), depEdges: [], depSprings: [], clusters: [],
	subClusters: [{ id: "x", label: null, members: nodes.map((n) => n.id), color: "#fff" }],
	colors: { node: "#fff", edge: "#aaa", label: "#bbb", hoverText: "#ccc" }, fontFamily: "x",
});
const ring = (n: number, cx: number, cy: number, r: number) =>
	Array.from({ length: n }, (_, i) => ({ id: `n${i}`, x: cx + Math.cos(i) * r, y: cy + Math.sin(i) * r, label: `n${i}` }));

async function renderer(camera: { k: number; x: number; y: number }, commits: unknown[]) {
	const { GraphCanvasRenderer } = await import("../../../components/graph/graph-canvas.ts");
	const r: any = new GraphCanvasRenderer(canvas, { onSelect() {}, onStageClick() {}, onCommit: (p: unknown) => commits.push(p), onCameraMove() {} } as any, camera);
	r.setSettings({ nodeSize: 6, labelSize: 10, labelZoom: 0.5, edgeWidth: 1 });
	return r;
}

describe("loading a settled layout", () => {
	it("re-centres an off-centre layout once, keeps the picture identical and does not slide on the first reheat", async () => {
		const commits: Array<Record<string, { x: number; y: number }>> = [];
		// Layout centred near (3000, 2000); the stored camera frames it.
		const r = await renderer({ k: 0.5, x: 400 - 1500, y: 300 - 1000 }, commits);
		const nodes = ring(12, 3000, 2000, 300);
		// n0 sits at world (3300, 2000): screen (550, 300) under the stored camera.
		r.setData(dataOf(nodes));
		assert.equal(commits.length, 1, "one recentre commit on load");
		const c = commits[0]!;
		const ids = Object.keys(c);
		assert.equal(ids.length, 12);
		assert.ok(Math.abs(ids.reduce((s, id) => s + c[id]!.x, 0)) < 1e-6 && Math.abs(ids.reduce((s, id) => s + c[id]!.y, 0)) < 1e-6, "centroid at the origin");
		assert.deepEqual([c.n0!.x * r.transform.k + r.transform.x, c.n0!.y * r.transform.k + r.transform.y], [550, 300]);
		const loaded = nodes.map((n) => [n.x, n.y]);
		// Reheat (what a drag does): the origin pull must not slide the whole layout.
		r.setPhysicsTuning({ gravity: 0.3 });
		await pump();
		r.destroy();
		// Re-annealing reshapes the ring, but the layout as a whole does not travel.
		const slide = Math.hypot(
			nodes.reduce((s, n, i) => s + n.x - loaded[i]![0]!, 0) / nodes.length,
			nodes.reduce((s, n, i) => s + n.y - loaded[i]![1]!, 0) / nodes.length,
		);
		assert.ok(slide < 60, `layout did not slide (centroid moved ${slide.toFixed(0)})`);
		assert.ok(commits.length <= 2, `the recentre commit plus at most the settle commit (${commits.length})`);
	});

	it("re-fits a restored camera that framed the partial graph when the full graph is only slightly larger but elsewhere", async () => {
		const commits: unknown[] = [];
		const r = await renderer({ k: 1, x: 400, y: 300 }, commits); // looks at the origin
		r.setData(dataOf(ring(3, 0, 0, 50)));
		assert.equal(r.transform.k, 1, "framed: kept");
		// Span grows under 2x (about 70 -> 120) yet the world no longer holds the camera centre.
		r.setData(dataOf(ring(12, 600, 0, 60)));
		r.destroy();
		assert.ok(r.transform.k > 1, `re-fitted (k=${r.transform.k})`);
	});

	it("re-fits a stored camera that framed the small first batch once the full data spreads far from it", async () => {
		const commits: unknown[] = [];
		const r = await renderer({ k: 1, x: 400, y: 300 }, commits); // looks at the origin
		r.setData(dataOf(ring(3, 0, 0, 50)));
		assert.equal(r.transform.k, 1, "framed: kept");
		r.setData(dataOf(ring(12, 9000, 9000, 2000)));
		r.destroy();
		assert.ok(r.transform.k < 0.2, `re-fitted to the big layout (k=${r.transform.k})`);
	});
});
