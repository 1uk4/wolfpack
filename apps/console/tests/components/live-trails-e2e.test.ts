import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { LiveOverlay, LIVE_DEFAULTS, type OverlayHost } from "../../components/graph/live/live-overlay.ts";
import { acquireLiveFeed, getLiveSnapshot, onLiveAction } from "../../components/graph/live/live-store.ts";

/** The real console path: SSE frame -> live-client -> live-store -> (live-layer wiring) overlay.dispatch -> step/items/draw as graph-canvas calls them. */
const g = globalThis as unknown as Record<string, unknown>;
const T0 = 5_000_000_000_000;
/** A 900-node graph fits at about this zoom, where the wolf icon is at its minimum size (compact: thread dots are hidden). */
const K = 0.3;
const frame = (event: unknown) => `data: ${JSON.stringify({ type: "pack.activity", at: "2026-11-26T00:00:00Z", event })}\n\n`;
const actor = { kind: "thread", wolf: "1uk4", threadId: "1uk4/home", title: "Home" };
const base = { v: 1, pack: "default", ttlMs: 300000, actor };

interface Stroke { from: [number, number]; to: [number, number]; style: string; width: number; dash: boolean }
function recorder() {
	const strokes: Stroke[] = [];
	const arcs: { x: number; y: number }[] = [];
	let path: [number, number][] = [];
	let dash = false;
	const st: Record<string, unknown> = { lineWidth: 1, strokeStyle: "", fillStyle: "", globalAlpha: 1 };
	const grad = { addColorStop: () => undefined };
	const ctx = new Proxy(st, {
		get: (t, p: string) => {
			if (p in t) return t[p];
			switch (p) {
				case "beginPath": return () => { path = []; };
				case "moveTo": case "lineTo": return (x: number, y: number) => path.push([x, y]);
				case "arc": return (x: number, y: number) => { path.push([x, y]); arcs.push({ x, y }); };
				case "setLineDash": return (d: number[]) => { dash = d.length > 0; };
				case "stroke": return () => {
					if (path.length === 2) strokes.push({ from: path[0]!, to: path[1]!, style: String(st.strokeStyle), width: Number(st.lineWidth), dash });
				};
				case "createRadialGradient": case "createLinearGradient": return () => grad;
				case "measureText": return () => ({ width: 1 });
				default: return () => undefined;
			}
		},
		set: (t, p: string, v) => { t[p] = v; return true; },
	}) as unknown as CanvasRenderingContext2D;
	return { ctx, strokes, arcs };
}
const alphaOfStyle = (s: string) => Number(/,([\d.]+)\)$/.exec(s)?.[1] ?? 0);

describe("live trails, end to end through the console path", () => {
	let off: (() => void) | null = null;
	let release: (() => void) | null = null;
	let o: LiveOverlay;
	const hadPath2D = g.Path2D;
	const enc = new TextEncoder();
	let push: (s: string) => void = () => {};

	beforeEach(() => {
		mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: T0 });
		g.Path2D = class {};
		g.document = { hidden: false, createElement: () => ({ getContext: () => null }), addEventListener: () => {}, removeEventListener: () => {} };
		g.fetch = async (url: string) => {
			if (url.includes("presence")) return new Response(JSON.stringify({ v: 1, at: T0, wolves: [], threads: [], subagents: [], owner: [] }), { status: 200 });
			const body = new ReadableStream<Uint8Array>({ start: (c) => { push = (s) => c.enqueue(enc.encode(s)); } });
			return new Response(body, { status: 200 });
		};
		o = new LiveOverlay(() => {});
		o.configure(LIVE_DEFAULTS);
		off = onLiveAction((a) => o.dispatch(a));
		release = acquireLiveFeed();
		o.loadState(getLiveSnapshot().state);
	});
	afterEach(() => {
		off?.();
		release?.();
		o.stop();
		mock.timers.reset();
		g.Path2D = hadPath2D;
		delete g.document;
		delete g.fetch;
	});

	const nodes = new Map<string, { x: number; y: number; color: string }>([
		["dom:wolfpack", { x: 0, y: 0, color: "#4488ff" }],
		["ent:kb-wolfpack-KNMBskd", { x: 300, y: 120, color: "#4488ff" }],
		["work:ELzLSkV", { x: -250, y: 200, color: "#ff8844" }],
	]);
	const host: OverlayHost = {
		nodePos: (id) => nodes.get(id) ?? null,
		hasNode: (id) => nodes.has(id),
		nodeColor: (id) => nodes.get(id)?.color,
		center: () => ({ x: 0, y: 0 }),
		extentRadius: () => 400,
		colors: { node: "#888888", edge: "#444444", label: "#ffffff", hoverText: "#ffffff" },
		fontFamily: "sans-serif",
	};
	const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); };
	const render = (rec: ReturnType<typeof recorder>, k = 1) => {
		const wall = Date.now();
		o.step(wall, 0.016, host, k);
		o.needsFrames(wall);
		o.draw(rec.ctx, host, k, wall);
	};

	it("draws a visible trail and arrival pulse from the wolf to the read KB entry, and the thread and you links", async () => {
		await flush();
		push(frame({ ...base, id: "a1", ts: T0, verb: "thread-active" }));
		push(frame({ ...base, id: "a2", ts: T0, verb: "bound", target: { kind: "work-item", id: "work-wolfpack-ELzLSkV", domain: "wolfpack", title: "Live map" } }));
		push(frame({ ...base, id: "a3", ts: T0, verb: "kb-read", target: { kind: "kb-entry", id: "kb-wolfpack-KNMBskd", domain: "wolfpack" } }));
		push(frame({ ...base, id: "a4", ts: T0, verb: "owner-viewing", actor: { kind: "owner" }, target: { kind: "kb-entry", id: "kb-wolfpack-KNMBskd", domain: "wolfpack" } }));
		await flush();
		render(recorder(), K); // first frame places the bodies and records the trail origin
		mock.timers.tick(400);
		const rec = recorder();
		render(rec, K);

		const target = nodes.get("ent:kb-wolfpack-KNMBskd")!;
		const trail = rec.strokes.filter((s) => !s.dash && Math.hypot(s.to[0] - target.x, s.to[1] - target.y) < 0.5);
		assert.equal(trail.length, 1, "one trail stroke ends on the KB entry");
		assert.ok(alphaOfStyle(trail[0]!.style) >= 0.5, `trail alpha ${trail[0]!.style}`);
		assert.ok(trail[0]!.width * K >= 1.5, `trail width ${trail[0]!.width}`);
		assert.ok(rec.arcs.some((a) => Math.hypot(a.x - target.x, a.y - target.y) < 0.5), "arrival pulse on the node");

		const work = nodes.get("work:ELzLSkV")!;
		const link = rec.strokes.filter((s) => s.dash && Math.hypot(s.to[0] - work.x, s.to[1] - work.y) < 0.5);
		assert.equal(link.length, 1, "bound thread links to its work node");
		assert.ok(alphaOfStyle(link[0]!.style) >= 0.4, `thread link alpha ${link[0]!.style}`);

		const youLink = rec.strokes.filter((s) => s.dash && Math.hypot(s.to[0] - target.x, s.to[1] - target.y) < 0.5);
		assert.equal(youLink.length, 1, "you-node links to the viewed entry");
		assert.ok(alphaOfStyle(youLink[0]!.style) >= 0.6, `you link alpha ${youLink[0]!.style}`);
	});
});
