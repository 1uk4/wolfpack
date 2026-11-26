import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { ActivityEvent } from "@wolfpack/protocol";
import { LiveOverlay, LIVE_DEFAULTS, type OverlayHost, type OverlayItem } from "../../components/graph/live/live-overlay.ts";
import { talkToWolf } from "../../components/graph/live/live-talk.ts";
import { formatFeed } from "../../src/core/graph/live/feed.ts";

/** Map model v2: features are hubs at their work node, subagents dart between targets and tether back, the wolf floats free. Real event shapes. */
const g = globalThis as unknown as Record<string, unknown>;
const T0 = 5_000_000_000_000;
const FEATURE = "1uk4/feature-work-wolfpack-ELzLSkV";
const feature = { kind: "thread", wolf: "1uk4", threadId: FEATURE, title: "Live pack map" };
const home = { kind: "thread", wolf: "1uk4", threadId: "1uk4/home" };
/** wolfd's own subagent event (title as name, parent known) and the hub-derived one (agent name, no parent). */
const subTap = { kind: "subagent", wolf: "1uk4", threadId: "1uk4/sub-1", subagent: "scout", parentThreadId: FEATURE, title: "scout" };
const subDerived = { kind: "subagent", wolf: "1uk4", threadId: "1uk4/sub-1", subagent: "explorer" };
const ENT = { kind: "kb-entry", id: "kb-wolfpack-KNMBskd", domain: "wolfpack", title: "Crawl Pipeline" };
const WORK = { kind: "work-item", id: "work-wolfpack-ELzLSkV", domain: "wolfpack", title: "Live map" };
let n = 0;
const ev = (verb: string, actor: unknown, target?: unknown): ActivityEvent => ({ v: 1, id: `m${++n}`, pack: "default", ts: T0, ttlMs: 3_600_000, actor, verb, ...(target ? { target } : {}) }) as unknown as ActivityEvent;

interface Stroke { from: [number, number]; to: [number, number]; style: string; width: number; dash: boolean }
function recorder() {
	const strokes: Stroke[] = [];
	let path: [number, number][] = [];
	let dash = false;
	const st: Record<string, unknown> = { lineWidth: 1, strokeStyle: "", fillStyle: "", globalAlpha: 1 };
	const grad = { addColorStop: () => undefined };
	const ctx = new Proxy(st, {
		get: (t, p: string) => {
			if (p in t) return t[p];
			switch (p) {
				case "beginPath": return () => { path = []; };
				case "moveTo": case "lineTo": case "arc": return (x: number, y: number) => path.push([x, y]);
				case "setLineDash": return (d: number[]) => { dash = d.length > 0; };
				case "stroke": return () => { if (path.length === 2) strokes.push({ from: path[0]!, to: path[1]!, style: String(st.strokeStyle), width: Number(st.lineWidth), dash }); };
				case "createRadialGradient": case "createLinearGradient": return () => grad;
				case "measureText": return () => ({ width: 1 });
				default: return () => undefined;
			}
		},
		set: (t, p: string, v) => { t[p] = v; return true; },
	}) as unknown as CanvasRenderingContext2D;
	return { ctx, strokes };
}
const alphaOfStyle = (s: string) => Number(/,([\d.]+)\)$/.exec(s)?.[1] ?? 0);
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const near = (p: [number, number], q: { x: number; y: number }, tol: number) => Math.hypot(p[0] - q.x, p[1] - q.y) <= tol;

describe("live map model v2", () => {
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
		colors: { node: "#888888", edge: "#444444", label: "#ffffff", hoverText: "#ffffff" },
		fontFamily: "sans-serif",
	};
	const hadPath2D = g.Path2D;
	let o: LiveOverlay;
	beforeEach(() => {
		mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: T0 });
		g.Path2D = class {};
		o = new LiveOverlay(() => {});
		o.configure(LIVE_DEFAULTS);
	});
	afterEach(() => {
		o.stop();
		mock.timers.reset();
		g.Path2D = hadPath2D;
		delete g.window;
	});
	const send = (verb: string, actor: unknown, target?: unknown, to: LiveOverlay = o) => to.dispatch({ type: "event", event: ev(verb, actor, target), now: Date.now() });
	/** Run the renderer's step loop for `sec` seconds of (mock) time at 20 steps per second. */
	const run = (sec: number, host_: OverlayHost = host, to: LiveOverlay = o) => {
		for (let i = 0; i < sec * 20; i++) {
			mock.timers.tick(50);
			to.step(Date.now(), 0.05, host_, 1);
		}
	};
	const items = (to: LiveOverlay = o) => to.items(host, 1, Date.now());
	const of = (kind: string, to: LiveOverlay = o): OverlayItem => items(to).find((i) => i.kind === kind)!;
	const render = (to: LiveOverlay = o) => {
		const rec = recorder();
		to.draw(rec.ctx, host, 1, Date.now());
		return rec.strokes;
	};

	it("a feature thread is a hub at its work-item node, not on its wolf", () => {
		send("thread-active", feature);
		send("thread-active", home);
		run(0.1);
		const hub = of("feature");
		assert.ok(dist(hub, nodes.get("work:ELzLSkV")!) < 30, `hub ${hub.x},${hub.y} is beside work:ELzLSkV`);
		assert.ok(dist(hub, of("wolf")) > 200, "and far from the wolf");
		assert.equal(items().filter((i) => i.kind === "thread").length, 1, "only the home thread stays a dot");
	});

	it("a feature with no work node anchors beside its domain node", () => {
		nodes.delete("work:ELzLSkV");
		try {
			send("thread-active", feature);
			run(0.1);
			assert.ok(dist(of("feature"), nodes.get("dom:wolfpack")!) < 50);
		} finally {
			nodes.set("work:ELzLSkV", { x: -250, y: 200, color: "#ff8844" });
		}
	});

	it("a spawned subagent starts at its hub, and the hub's own thread events leave the wolf out of it", () => {
		send("thread-active", feature);
		send("subagent-spawned", subTap);
		run(0.1);
		assert.ok(dist(of("subagent"), of("feature")) < 8, "the subagent leaves from the hub");
	});

	it("a subagent's kb-read darts it toward the entry from where it was, joined to its spawn by its own thread id", () => {
		send("thread-active", feature);
		send("subagent-spawned", subTap);
		run(0.1);
		const p0 = { x: of("subagent").x, y: of("subagent").y };
		const target = nodes.get("ent:kb-wolfpack-KNMBskd")!;
		send("kb-read", subDerived, ENT); // the hub-derived shape: another name, no parent
		assert.equal(items().filter((i) => i.kind === "subagent").length, 1, "still one subagent");
		run(1.5);
		const mid = of("subagent");
		assert.ok(dist(mid, target) < dist(p0, target) * 0.4, `moved toward the entry (${dist(p0, target)} -> ${dist(mid, target)})`);
		const trail = render().filter((s) => !s.dash && near(s.to, target, 0.5));
		assert.equal(trail.length, 1, "one trail ends on the entry");
		assert.ok(near(trail[0]!.from, p0, 6), "and starts where the subagent was");
		assert.ok(alphaOfStyle(trail[0]!.style) >= 0.5);
	});

	it("a subagent hops from one target to the next", () => {
		send("thread-active", feature);
		send("subagent-spawned", subTap);
		send("kb-read", subTap, ENT);
		run(3);
		const first = of("subagent");
		send("bound", subTap, WORK);
		run(3);
		const second = of("subagent");
		assert.ok(dist(second, nodes.get("work:ELzLSkV")!) < dist(first, nodes.get("work:ELzLSkV")!) * 0.4);
		assert.equal(of("feature").working, true);
	});

	it("with no target for more than 10 s the tether reels a subagent back to its hub", () => {
		send("thread-active", feature);
		send("subagent-spawned", subTap);
		send("kb-read", subTap, ENT);
		run(3);
		const away = dist(of("subagent"), of("feature"));
		assert.ok(away > 300, `it is out at the entry (${away})`);
		run(9); // 12 s since the target
		run(8);
		assert.ok(dist(of("subagent"), of("feature")) < 50, `it drifted home (${dist(of("subagent"), of("feature"))})`);
	});

	it("a finished subagent flies back to its hub and is still there fading", () => {
		send("thread-active", feature);
		send("subagent-spawned", subTap);
		send("kb-read", subTap, ENT);
		run(3);
		const out = dist(of("subagent"), of("feature"));
		send("subagent-finished", subTap);
		run(3);
		const sub = of("subagent");
		assert.ok(dist(sub, of("feature")) < out * 0.3, `back toward the hub (${out} -> ${dist(sub, of("feature"))})`);
		assert.ok(sub.alpha > 0 && sub.alpha < 1, `fading (${sub.alpha})`);
	});

	it("the tether is a hairline at very low alpha", () => {
		send("thread-active", feature);
		send("subagent-spawned", subTap);
		send("kb-read", subTap, ENT);
		run(2);
		const hub = of("feature");
		const sub = of("subagent");
		const rec = recorder();
		o.draw(rec.ctx, host, 1, Date.now());
		const tether = rec.strokes.filter((s) => !s.dash && near(s.from, hub, 0.5) && near(s.to, sub, 0.5));
		assert.equal(tether.length, 1);
		const a = alphaOfStyle(tether[0]!.style);
		assert.ok(a >= 0.08 && a <= 0.12, `tether alpha ${a}`);
		assert.ok(tether[0]!.width <= 1, `hairline ${tether[0]!.width}`);
	});

	it("an idle feature stays on the map, dimmed", () => {
		send("thread-active", feature);
		send("thread-idle", feature);
		mock.timers.tick(20 * 60_000);
		o.dispatch({ type: "tick", now: Date.now() });
		run(0.1);
		const hub = of("feature");
		assert.equal(hub.working, false);
		assert.ok(hub.alpha > 0 && hub.alpha < 1, `dimmed (${hub.alpha})`);
	});

	it("the wolf floats free: feature and subagent targets never move it", () => {
		const big: OverlayHost = { ...host, extentRadius: () => 600 };
		const b = new LiveOverlay(() => {});
		b.configure(LIVE_DEFAULTS);
		send("thread-active", home);
		send("thread-active", home, undefined, b);
		send("thread-active", feature);
		send("subagent-spawned", subTap);
		send("kb-read", subTap, ENT);
		send("kb-read", feature, ENT);
		for (let i = 0; i < 80; i++) {
			mock.timers.tick(50);
			o.step(Date.now(), 0.05, big, 1);
			b.step(Date.now(), 0.05, big, 1);
		}
		const wolfA = items().find((i) => i.kind === "wolf")!;
		const wolfB = b.items(host, 1, Date.now()).find((i) => i.kind === "wolf")!;
		assert.ok(dist(wolfA, wolfB) < 1e-6, `the wolf is on the same roam path (${dist(wolfA, wolfB)})`);
		b.stop();
	});

	it("a home-thread bind to a feature draws a wolf-to-feature link; the feature's own action starts at its hub", () => {
		send("thread-active", feature);
		send("thread-active", home);
		run(0.1);
		send("bound", home, WORK);
		send("kb-read", feature, ENT);
		run(0.1);
		const hub = of("feature");
		const wolf = of("wolf");
		const strokes = render();
		const link = strokes.filter((s) => !s.dash && near(s.to, hub, 0.5) && near(s.from, wolf, 6));
		assert.equal(link.length, 1, "a link from the wolf to the hub");
		const own = strokes.filter((s) => !s.dash && near(s.to, nodes.get("ent:kb-wolfpack-KNMBskd")!, 0.5));
		assert.equal(own.length, 1);
		assert.ok(near(own[0]!.from, hub, 6), "the feature thread's trail leaves from the hub, not the wolf");
	});

	it("reduced motion: no float or roam, subagents snap to their target", () => {
		g.window = { matchMedia: () => ({ matches: true }), innerWidth: 1280 };
		const still = new LiveOverlay(() => {});
		still.configure(LIVE_DEFAULTS);
		send("thread-active", feature, undefined, still);
		send("subagent-spawned", subTap, undefined, still);
		send("kb-read", subTap, ENT, still);
		const big: OverlayHost = { ...host, extentRadius: () => 600 };
		still.step(T0, 0.016, big, 1);
		const w0 = still.items(host, 1, T0).find((i) => i.kind === "wolf")!;
		const sub = still.items(host, 1, T0).find((i) => i.kind === "subagent")!;
		const d = dist(sub, nodes.get("ent:kb-wolfpack-KNMBskd")!);
		assert.ok(d > 10 && d < 16, `snapped beside the entry (${d})`);
		still.step(T0 + 30_000, 0.016, big, 1);
		const w1 = still.items(host, 1, T0 + 17_000).find((i) => i.kind === "wolf")!;
		assert.ok(dist(w0, w1) < 1e-9, "the wolf neither roams nor floats");
		assert.equal(still.needsFrames(0), false);
		still.stop();
	});

	it("cards: a subagent shows its target, a feature its wolf, state and subagent count; private view hides titles", () => {
		send("thread-active", feature);
		send("subagent-spawned", subTap);
		send("kb-read", subTap, ENT);
		run(1);
		const its = items();
		const sub = its.find((i) => i.kind === "subagent")!;
		const hubItem = its.find((i) => i.kind === "feature")!;
		const hit = (it: OverlayItem) => o.hitTest(it.x, it.y, { x: 0, y: 0, k: 1 }, 0.5)!;
		assert.ok(o.cardFor(hit(sub)).lines.includes("Target: Crawl Pipeline"));
		const hubCard = o.cardFor(hit(hubItem));
		assert.equal(hubCard.title, "Live pack map");
		assert.deepEqual(hubCard.lines, ["Wolf: 1uk4", "Working", "Subagents: 1"]);
		o.setPrivate(true);
		assert.ok(!JSON.stringify([o.cardFor(hit(sub)), o.cardFor(hit(hubItem))]).includes("Crawl Pipeline"));
		assert.ok(!o.cardFor(hit(hubItem)).title.includes("Live pack map"));
	});

	it("feed lines name the actor by feature title or subagent name, and private view hides the title", () => {
		const fe = (verb: string, actor: Record<string, unknown>, target?: Record<string, unknown>) => ({ id: `f${++n}`, at: T0, ts: T0, verb, actor, target }) as never;
		const lines = formatFeed([fe("kb-read", feature, { kind: "kb-entry", id: "kb-wolfpack-A", title: "Alpha" }), fe("kb-read", subTap, { kind: "kb-entry", id: "kb-wolfpack-B", title: "Beta" })], {});
		assert.equal(lines[0]!.text, "1uk4 · Live pack map read Alpha");
		assert.equal(lines[1]!.text, "1uk4 · scout read Beta");
		assert.equal(formatFeed([fe("kb-read", feature, { kind: "kb-entry", id: "kb-wolfpack-A", title: "Alpha" })], { private: true })[0]!.text, "1uk4 · feature read");
	});
});

describe("clicking a wolf talks to it", () => {
	beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
	afterEach(() => mock.timers.reset());
	const threads = { "1uk4": [{ id: "1uk4/feature-x", title: "x", kind: "feature" }, { id: "1uk4/home", title: "1uk4", kind: "home" }] };

	it("points the floating chat at the wolf's home thread and focuses it", () => {
		const calls: string[] = [];
		const did = talkToWolf("1uk4", { threads, attach: (r) => calls.push(`attach ${r.wolf} ${r.threadId}`), focusComposer: () => calls.push("focus"), navigate: (h) => calls.push(`go ${h}`) });
		assert.equal(did, "composer");
		mock.timers.tick(1);
		assert.deepEqual(calls, ["attach 1uk4 1uk4/home", "focus"]);
	});

	it("opens the home thread's page when there is no floating chat", () => {
		const calls: string[] = [];
		assert.equal(talkToWolf("1uk4", { threads, focusComposer: () => undefined, navigate: (h) => calls.push(h) }), "page");
		assert.equal(calls.length, 1);
		assert.ok(calls[0]!.includes("home"));
	});
});
