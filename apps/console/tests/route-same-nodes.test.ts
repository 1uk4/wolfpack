/**
 * Route straightening moves the REAL nodes: one position per node, shared by
 * the discs, labels, halos, hit-testing and every edge. Drives the actual
 * GraphCanvasRenderer on a stubbed canvas and compares the node objects, the
 * disc geometry it built and the layout targets.
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
	Path2D: class {
		pts: number[][] = [];
		moveTo() {}
		lineTo() {}
		arc(x: number, y: number) { this.pts.push([x, y]); }
		closePath() {}
	},
});
const pump = async () => {
	for (let i = 0; i < 40; i++) {
		await new Promise((r) => setTimeout(r, 15));
		const f = frames;
		frames = [];
		f.forEach((x) => x());
	}
};

const sel = (steps: string[][], target: string) => ({
	nodes: new Set(["fac:d", ...steps.flat()]), edges: new Set<string>(), parallel: new Set<string>(), done: new Set<string>(),
	layout: { root: "fac:d", target, steps },
});

async function setup() {
	const { GraphCanvasRenderer } = await import("../components/graph-canvas.ts");
	const { routeTargetLayout } = await import("../src/core/route-layout.ts");
	const r: any = new GraphCanvasRenderer(canvas, { onSelect() {}, onStageClick() {}, onCommit() {}, onCameraMove() {} } as any, { k: 1, x: 400, y: 300 });
	const nodes = [["fac:d", 0, 0], ["a", 50, 80], ["b", -60, 120], ["t", 200, 90], ["u", 300, -40]].map(([id, x, y]) => ({ id: id as string, x: x as number, y: y as number, label: id as string }));
	r.setSettings({ nodeSize: 6, labelSize: 10, labelZoom: 0.5, edgeWidth: 1 });
	r.setData({
		nodes, edges: [{ from: "fac:d", to: "a" }], depEdges: [], depSprings: [], clusters: [],
		subClusters: [{ id: "x", label: null, members: nodes.map((n) => n.id), color: "#fff" }],
		colors: { node: "#fff", edge: "#aaa", label: "#bbb", hoverText: "#ccc" }, fontFamily: "x",
	});
	return { r, nodes, routeTargetLayout };
}
const discs = (r: any): number[][] => r.nodeGroups.flatMap((g: any) => g.path.pts);

describe("route straightening moves the real nodes", () => {
	it("node positions used for drawing equal the layout targets", async () => {
		const { r, nodes, routeTargetLayout } = await setup();
		r.setRoute(sel([["a", "b"], ["t"]], "t"));
		await pump();
		const targets = routeTargetLayout("fac:d", "t", { root: { x: 0, y: 0 }, target: { x: 200, y: 90 } }, [["a", "b"], ["t"]]);
		for (const [id, p] of targets) {
			const n = nodes.find((x) => x.id === id)!;
			assert.ok(r.nodeById.get(id) === n, "the renderer draws the very node objects it was given");
			assert.deepEqual([n.x, n.y], [p.x, p.y], id);
			assert.ok(discs(r).some(([x, y]) => x === p.x && y === p.y), `disc of ${id} drawn at its target`);
		}
		for (const [x, y] of discs(r)) assert.ok(nodes.some((n) => n.x === x && n.y === y), "every disc sits on a node");
		assert.deepEqual([nodes[4]!.x, nodes[4]!.y], [300, -40], "non-route nodes stay put");
	});
	it("deselect restores the original positions on the same objects", async () => {
		const { r, nodes } = await setup();
		r.setRoute(sel([["a", "b"], ["t"]], "t"));
		await pump();
		r.setRoute(null);
		await pump();
		assert.deepEqual(nodes.map((n) => [n.x, n.y]), [[0, 0], [50, 80], [-60, 120], [200, 90], [300, -40]]);
		assert.equal(r.home.size, 0);
	});
	it("a route switch anchors on the normal positions, not the displaced ones", async () => {
		const { r, nodes, routeTargetLayout } = await setup();
		r.setRoute(sel([["a"], ["b"], ["t"]], "t"));
		await pump();
		r.setRoute(sel([["b"], ["a"]], "a"));
		await pump();
		const want = routeTargetLayout("fac:d", "a", { root: { x: 0, y: 0 }, target: { x: 50, y: 80 } }, [["b"], ["a"]]);
		for (const [id, p] of want) {
			const n = nodes.find((x) => x.id === id)!;
			assert.deepEqual([n.x, n.y], [p.x, p.y], id);
		}
		assert.deepEqual([nodes[3]!.x, nodes[3]!.y], [200, 90], "the old route's target went home");
	});
});
