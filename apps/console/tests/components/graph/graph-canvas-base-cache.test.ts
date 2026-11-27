/**
 * The graph's base layers (regions, edges, nodes, labels, hover, pulses) are cached offscreen: an overlay-only frame blits the
 * cache and draws the overlay, any change to the base redraws it. Drives the real GraphCanvasRenderer on a recording canvas;
 * `stroke` calls are the base's edge layer, `drawImage` of the cache is the blit.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const counts = { stroke: 0, drawImage: 0 };
const mkCtx = (): any =>
	new Proxy({}, {
		get: (_t, p) =>
			p === "canvas" ? {} :
			p === "measureText" ? () => ({ width: 10 }) :
			p === "getImageData" || p === "createImageData" ? (...a: number[]) => ({ data: new Uint8ClampedArray(4 * (a[2] ?? a[0]!) * (a[3] ?? a[1]!)) }) :
			p === "createRadialGradient" || p === "createLinearGradient" ? () => ({ addColorStop() {} }) :
			p === "stroke" ? () => void counts.stroke++ :
			p === "drawImage" ? () => void counts.drawImage++ :
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
const pump = async () => {
	for (let i = 0; i < 12; i++) {
		await new Promise((r) => setTimeout(r, 5));
		const f = frames;
		frames = [];
		f.forEach((x) => x());
	}
};

async function setup() {
	const { GraphCanvasRenderer } = await import("../../../components/graph/graph-canvas.ts");
	const r: any = new GraphCanvasRenderer(canvas, { onSelect() {}, onStageClick() {}, onCommit() {}, onCameraMove() {} } as any, { k: 1, x: 400, y: 300 });
	const nodes = [["a", 0, 0], ["b", 50, 80], ["c", -60, 120]].map(([id, x, y]) => ({ id: id as string, x: x as number, y: y as number, label: id as string }));
	r.setSettings({ nodeSize: 6, labelSize: 10, labelZoom: 0.5, edgeWidth: 1 });
	r.setData({
		nodes, edges: [{ from: "a", to: "b" }], depEdges: [], depSprings: [], clusters: [],
		subClusters: [{ id: "x", label: null, members: nodes.map((n) => n.id), color: "#fff" }],
		colors: { node: "#fff", edge: "#aaa", label: "#bbb", hoverText: "#ccc" }, fontFamily: "x",
	});
	let overlayDraws = 0;
	r.setOverlay({ step() {}, needsFrames: () => false, minFrameMs: 0, draw() { overlayDraws++; }, hitTest: () => null, setHighlight() {}, fillObstacles: () => ({ n: 0, sig: 0 }) });
	await pump(); // the sim settles and the base is drawn
	return { r, overlayDraws: () => overlayDraws };
}

describe("graph base layer cache", () => {
	beforeEach(() => {
		counts.stroke = 0;
		counts.drawImage = 0;
		frames = [];
	});

	it("an overlay-only redraw blits the cached base and draws the overlay without redrawing edges and nodes", async () => {
		const { r, overlayDraws } = await setup();
		const strokes = counts.stroke;
		const blits = counts.drawImage;
		const draws = overlayDraws();
		r.requestRedraw();
		r.requestRedraw();
		await pump();
		assert.equal(overlayDraws(), draws + 1);
		assert.equal(counts.stroke, strokes, "edges were not drawn again");
		assert.ok(counts.drawImage > blits, "the cached base was blitted");
		r.destroy();
	});

	it("a settings change or a search filter redraws the base (the cache is never stale)", async () => {
		const { r } = await setup();
		let strokes = counts.stroke;
		r.setSettings({ nodeSize: 8, labelSize: 10, labelZoom: 0.5, edgeWidth: 1 });
		await pump();
		assert.ok(counts.stroke > strokes, "settings redraw the base");
		strokes = counts.stroke;
		r.setVisible(new Set(["a"]));
		await pump();
		assert.ok(counts.stroke > strokes, "search visibility redraws the base");
		r.destroy();
	});

	it("replaced node ids redraw the base once when the set changes, never when the same set is set again", async () => {
		const { r } = await setup();
		let strokes = counts.stroke;
		r.setReplacedNodes(new Set(["a"]));
		await pump();
		assert.ok(counts.stroke > strokes, "a changed set redraws the base");
		strokes = counts.stroke;
		r.setReplacedNodes(new Set(["a"]));
		r.requestRedraw();
		await pump();
		assert.equal(counts.stroke, strokes, "an equal set leaves the cached base alone");
		r.setReplacedNodes(new Set());
		await pump();
		assert.ok(counts.stroke > strokes, "clearing the set redraws the base");
		r.destroy();
	});
});
