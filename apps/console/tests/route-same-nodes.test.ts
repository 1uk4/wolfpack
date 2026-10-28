/**
 * Route selection is physics, not a second view: one position per node (the
 * sim's), shared by the discs, labels, halos, hit-testing and every edge. The
 * sim keeps running and every node drags as on the normal map. Drives the
 * actual GraphCanvasRenderer on a stubbed canvas.
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
	nodes: new Set(["fac:d", ...steps.flat()]), edges: new Set<string>(["fac:d|a", "fac:d|b", "a|t", "b|t"]), parallel: new Set<string>(), done: new Set<string>(),
	layout: { root: "fac:d", target, steps },
});

async function setup() {
	const { GraphCanvasRenderer } = await import("../components/graph-canvas.ts");
	const r: any = new GraphCanvasRenderer(canvas, { onSelect() {}, onStageClick() {}, onCommit() {}, onCameraMove() {} } as any, { k: 1, x: 400, y: 300 });
	const nodes = [["fac:d", 0, 0], ["a", 50, 80], ["b", -60, 120], ["t", 200, 90], ["u", 300, -40]].map(([id, x, y]) => ({ id: id as string, x: x as number, y: y as number, label: id as string } as { id: string; x: number; y: number; label: string; fx?: number | null; fy?: number | null }));
	r.setSettings({ nodeSize: 6, labelSize: 10, labelZoom: 0.5, edgeWidth: 1 });
	r.setData({
		nodes, edges: [{ from: "fac:d", to: "a" }], depEdges: [], depSprings: [], clusters: [],
		subClusters: [{ id: "x", label: null, members: nodes.map((n) => n.id), color: "#fff" }],
		colors: { node: "#fff", edge: "#aaa", label: "#bbb", hoverText: "#ccc" }, fontFamily: "x",
	});
	return { r, nodes };
}
const discs = (r: any): number[][] => r.nodeGroups.flatMap((g: any) => g.path.pts);

const links = (r: any): string[] => r.sim.force("link").links().map((l: any) => `${l.source.id}>${l.target.id}`).sort();
const NORMAL = ["fac:d>a"];
const dist = (n: any, p: { x: number; y: number }) => Math.hypot(n.x - p.x, n.y - p.y);

describe("route selection runs on the same simulation", () => {
	it("drawn positions are the sim's: same node objects, discs on nodes, no pins, nothing frozen", async () => {
		const { r, nodes } = await setup();
		r.setRoute(sel([["a", "b"], ["t"]], "t"));
		assert.ok(r.simActive, "reheated, not frozen");
		await pump();
		for (const n of nodes) {
			assert.ok(r.nodeById.get(n.id) === n && r.simById.get(n.id) === n, "renderer and sim share the given objects");
			assert.ok(n.fx == null && n.fy == null, "nothing pinned");
		}
		for (const [x, y] of discs(r)) assert.ok(nodes.some((n) => n.x === x && n.y === y), "every disc sits on a node");
		assert.deepEqual(r.positions().get("a"), { x: nodes[1]!.x, y: nodes[1]!.y });
	});
	it("links: members' hierarchy links swapped for the route's edges; the line force is installed", async () => {
		const { r } = await setup();
		assert.deepEqual(links(r), NORMAL);
		r.setRoute(sel([["a", "b"], ["t"]], "t"));
		assert.deepEqual(links(r), ["a>t", "b>t", "fac:d>a", "fac:d>b"]);
		assert.ok(r.sim.force("routeLine"));
	});
	it("members relax toward the Factory -> target line over ticks, without being placed on it", async () => {
		const { r, nodes } = await setup();
		const line = (id: string) => {
			// distance of the node from the Factory -> t segment
			const n = nodes.find((x) => x.id === id)!;
			const t = nodes[3]!;
			return Math.abs(t.x * n.y - t.y * n.x) / Math.hypot(t.x, t.y);
		};
		const before = line("b");
		r.setRoute(sel([["a", "b"], ["t"]], "t"));
		await pump();
		assert.ok(line("b") < before, `b ${line("b")} < ${before}`);
		assert.ok(nodes.every((n) => n.fx == null), "free throughout");
	});
	it("deselect: normal links back, line force gone, gentle reheat, no special restore", async () => {
		const { r, nodes } = await setup();
		r.setRoute(sel([["a", "b"], ["t"]], "t"));
		await pump();
		r.setRoute(null);
		assert.deepEqual(links(r), NORMAL);
		assert.equal(r.sim.force("routeLine"), undefined);
		assert.ok(r.simActive && r.sim.alpha() >= 0.3, "reheated like a drag");
		assert.ok(!r.straighten);
		await pump();
		assert.ok(nodes.every((n) => n.fx == null));
	});
});

describe("dragging while a route is selected is the normal drag", () => {
	// Canvas listeners are stubbed; call the handlers directly (camera k=1, origin 400,300).
	const ev = (x: number, y: number) => ({ button: 0, clientX: x + 400, clientY: y + 300, pointerId: 1, preventDefault() {} });
	const withSelect = async () => {
		const s = await setup();
		const selected: string[] = [];
		s.r.callbacks.onSelect = (id: string) => selected.push(id);
		s.r.setRoute(sel([["a", "b"], ["t"]], "t"));
		await pump();
		return { ...s, selected };
	};
	for (const id of ["a", "t", "fac:d", "u"]) {
		it(`${id === "u" ? "a non-route node" : id === "fac:d" ? "the Factory" : `route node ${id}`} follows the cursor, then is released free`, async () => {
			const { r, nodes, selected } = await withSelect();
			const n = nodes.find((x) => x.id === id)!;
			r.onPointerDown(ev(n.x, n.y));
			r.onPointerMove(ev(n.x + 120, n.y + 60));
			const want = { x: n.x + 120, y: n.y + 60 };
			await pump();
			assert.ok(r.simActive && r.sim.alphaTarget() === 0.3, "sim is hot during the drag");
			assert.ok(dist(n, want) < 1e-6, "pinned to the cursor while held");
			r.onPointerUp(ev(want.x, want.y));
			assert.ok(n.fx == null && n.fy == null, "released");
			assert.deepEqual(selected, [], "a drag does not select");
			await pump();
			assert.ok(r.sim.force("routeLine"), "selection stays");
		});
	}
	it("dragging the selected node bends the route (members follow the moved end)", async () => {
		const { r, nodes } = await withSelect();
		const a = nodes[1]!;
		const before = a.y;
		const t = nodes[3]!;
		r.onPointerDown(ev(t.x, t.y));
		r.onPointerMove(ev(t.x, t.y + 600));
		for (let i = 0; i < 3; i++) await pump();
		r.onPointerUp(ev(t.x, t.y));
		assert.ok(a.y > before! + 40, `${a.y} > ${before}`);
	});
	it("click vs drag threshold", async () => {
		const { r, nodes, selected } = await withSelect();
		const t = nodes[3]!;
		r.onPointerDown(ev(t.x, t.y));
		r.onPointerMove(ev(t.x + 2, t.y + 2));
		r.onPointerUp(ev(t.x + 2, t.y + 2));
		assert.deepEqual(selected, ["t"], "tiny movement is a click (even while the sim is relaxing)");
	});
});
