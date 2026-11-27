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
	const replacedCalls: string[][] = [];
	(host as { setReplacedNodes?: (ids: ReadonlySet<string>) => void }).setReplacedNodes = (ids) => void replacedCalls.push([...ids].sort());
	const hadPath2D = g.Path2D;
	let o: LiveOverlay;
	beforeEach(() => {
		mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: T0 });
		g.Path2D = class {};
		replacedCalls.length = 0;
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
		assert.ok(dist(hub, of("wolf")) > 100, "and clear of the wolf, which only settles partway toward it");
		assert.equal(items().filter((i) => i.kind === "thread").length, 1, "only the home thread stays a dot");
	});

	it("a feature hub sits exactly on its work node, with no offset and no float, and replaces that node's dot only while the thread is open", () => {
		const row = { wolf: "1uk4", id: FEATURE, title: "Live pack map" };
		o.dispatch({ type: "threads", threads: [row], now: Date.now() });
		run(0.1);
		for (const t of [0, 1700, 4100]) {
			mock.timers.tick(t);
			const hub = items().find((i) => i.kind === "feature")!;
			assert.deepEqual([hub.x, hub.y], [-250, 200]);
		}
		run(0.5);
		assert.deepEqual(replacedCalls, [["work:ELzLSkV"]], "the node is replaced, announced once");
		o.dispatch({ type: "threads", threads: [{ ...row, closed: true }], now: Date.now() });
		run(0.1);
		assert.deepEqual(replacedCalls, [["work:ELzLSkV"], []], "archived: the normal dot comes back");
	});

	it("the you badge sits above the composer in screen space and never moves with pan or zoom; without a composer it takes the bottom-centre fallback", () => {
		send("thread-active", feature);
		run(0.1);
		items();
		const size = { w: 800, h: 600 };
		o.setComposerRect({ x: 100, y: 500, w: 400, h: 60 });
		const a = o.screenGeometry(host, { x: 0, y: 0, k: 1 }, size)!.badge;
		assert.equal(a.x, 300, "horizontally centred on the composer");
		assert.ok(a.y < 500 - a.r && a.y > 500 - 40, `just above its top edge (${a.y})`);
		const b = o.screenGeometry(host, { x: -300, y: 120, k: 2.5 }, size)!.badge;
		assert.deepEqual([b.x, b.y], [a.x, a.y]);
		const arcs: number[][] = [];
		const ctx = new Proxy({}, { get: (_t, p) => (p === "arc" ? (x: number, y: number, r: number) => arcs.push([x, y, r]) : () => undefined), set: () => true }) as unknown as CanvasRenderingContext2D;
		o.drawScreen(ctx, host, { x: -300, y: 120, k: 2.5 }, size, 0);
		assert.deepEqual(arcs[0]!.slice(0, 2), [a.x, a.y], "the badge is drawn there");
		o.setComposerRect(null);
		const f = o.screenGeometry(host, { x: 0, y: 0, k: 1 }, size)!.badge;
		assert.equal(f.x, 400);
		assert.ok(f.y > 500 && f.y < 600 - f.r, `bottom-centre with a margin (${f.y})`);
	});

	it("the you badge's chat link ends at the feature hub for a feature thread and at the wolf for a home thread", () => {
		send("thread-active", feature);
		send("thread-active", home);
		run(0.1);
		const tr = { x: 400, y: 100, k: 1 };
		const size = { w: 800, h: 600 };
		const at = (id: string) => ({ x: items().find((i) => i.key === id)!.x + tr.x, y: items().find((i) => i.key === id)!.y + tr.y });
		o.setAttached({ wolf: "1uk4", threadId: FEATURE });
		items();
		const hub = o.screenGeometry(host, tr, size)!.links.find((l) => l.kind === "chat")!;
		assert.deepEqual([hub.x, hub.y], [-250 + tr.x, 200 + tr.y]);
		o.setAttached({ wolf: "1uk4", threadId: "1uk4/home" });
		const wolf = o.screenGeometry(host, tr, size)!.links.find((l) => l.kind === "chat")!;
		assert.deepEqual([wolf.x, wolf.y], [at("1uk4").x, at("1uk4").y]);
	});

	it("a chat target off the canvas ends its link at the canvas edge with an arrow", () => {
		send("thread-active", feature);
		run(0.1);
		items();
		o.setAttached({ wolf: "1uk4", threadId: FEATURE });
		const size = { w: 800, h: 600 };
		const on = o.screenGeometry(host, { x: 400, y: 100, k: 1 }, size)!.links[0]!;
		assert.equal(on.arrow, false);
		const off = o.screenGeometry(host, { x: 5000, y: 100, k: 1 }, size)!.links[0]!;
		assert.equal(off.arrow, true);
		assert.ok(off.x >= 0 && off.x <= 800 && off.y >= 0 && off.y <= 600, `clipped to the canvas (${off.x},${off.y})`);
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

	it("a running subagent is a small icon on its feature's ring, joined to it by a link, and gone once it has finished and faded", () => {
		send("thread-active", feature);
		send("subagent-spawned", subTap);
		run(5);
		const hub = of("feature");
		const sub = of("subagent");
		assert.ok(Math.abs(dist(sub, hub) - 28) < 2, `on the ring (${dist(sub, hub)})`);
		assert.ok(hub.r > sub.r * 3 && sub.r > 5 && sub.r < 8, `a small icon (${sub.r}) on a bigger ring (${hub.r})`);
		const link = render().filter((s) => !s.dash && near(s.from, hub, 0.5) && near(s.to, sub, 0.5));
		assert.equal(link.length, 1, "one link line from the ring's centre to the subagent");
		send("subagent-finished", subTap);
		run(20);
		assert.equal(items().filter((i) => i.kind === "subagent").length, 0, "removed after the fade");
	});

	it("several subagents of one feature sit evenly spaced on its ring", () => {
		const subB = { ...subTap, threadId: "1uk4/sub-2", subagent: "scout2", title: "scout2" };
		const subC = { ...subTap, threadId: "1uk4/sub-3", subagent: "scout3", title: "scout3" };
		send("thread-active", feature);
		send("subagent-spawned", subTap);
		send("subagent-spawned", subB);
		send("subagent-spawned", subC);
		run(8);
		const hub = of("feature");
		const subs = items().filter((i) => i.kind === "subagent");
		assert.equal(subs.length, 3);
		for (const s of subs) assert.ok(Math.abs(dist(s, hub) - 28) < 2, `on the ring (${dist(s, hub)})`);
		const gaps = [dist(subs[0]!, subs[1]!), dist(subs[1]!, subs[2]!), dist(subs[2]!, subs[0]!)];
		assert.ok(Math.max(...gaps) - Math.min(...gaps) < 3, `equal gaps ${gaps}`);
	});

	it("a subagent's kb-read stretches its own icon toward the entry while the group only drifts, and the trail starts at the icon", () => {
		send("thread-active", feature);
		send("subagent-spawned", subTap);
		run(0.1);
		const p0 = { x: of("subagent").x, y: of("subagent").y };
		const hub0 = { x: of("feature").x, y: of("feature").y };
		const target = nodes.get("ent:kb-wolfpack-KNMBskd")!;
		send("kb-read", subDerived, ENT); // the hub-derived shape: another name, no parent
		assert.equal(items().filter((i) => i.kind === "subagent").length, 1, "still one subagent");
		run(8);
		const sub = of("subagent");
		assert.ok(dist(sub, target) < dist(p0, target) * 0.7, `stretched toward the entry (${dist(p0, target)} -> ${dist(sub, target)})`);
		assert.ok(dist(of("feature"), hub0) < 30, `the group drifted only a little (${dist(of("feature"), hub0)})`);
		const trail = render().filter((s) => !s.dash && near(s.to, target, 0.5));
		assert.equal(trail.length, 1, "one trail ends on the entry");
		assert.ok(near(trail[0]!.from, sub, 0.5), "and starts at the subagent's icon, following it");
	});

	it("a subagent's next event re-aims its stretch", () => {
		send("thread-active", feature);
		send("subagent-spawned", subTap);
		send("kb-read", subTap, ENT);
		run(5);
		const first = of("subagent");
		send("bound", subTap, WORK);
		run(8);
		const second = of("subagent");
		assert.ok(dist(second, nodes.get("work:ELzLSkV")!) < dist(first, nodes.get("work:ELzLSkV")!), "now closer to the new target");
		assert.equal(of("feature").working, true);
	});

	it("once the hold ends the tether snaps a subagent back to its slot on the ring", () => {
		send("thread-active", feature);
		send("subagent-spawned", subTap);
		send("kb-read", subTap, ENT);
		run(5);
		const away = dist(of("subagent"), of("feature"));
		assert.ok(away > 100, `it is stretched out (${away})`);
		run(40);
		const home_ = dist(of("subagent"), of("feature"));
		assert.ok(Math.abs(home_ - 28) < 2, `back on the ring (${home_})`);
	});

	it("a finished subagent is back on its ring and still there fading", () => {
		send("thread-active", feature);
		send("subagent-spawned", subTap);
		send("kb-read", subTap, ENT);
		run(5);
		send("subagent-finished", subTap);
		run(13);
		const sub = of("subagent");
		assert.ok(Math.abs(dist(sub, of("feature")) - 28) < 3, `on the ring (${dist(sub, of("feature"))})`);
		assert.ok(sub.alpha > 0 && sub.alpha < 1, `fading (${sub.alpha})`);
	});

	it("the link to the hub is a visible hairline", () => {
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
		assert.ok(a >= 0.25 && a <= 0.4, `link alpha ${a}`);
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

	it("an open feature thread in the thread roster is a dimmed hub with no presence; archiving or dropping it removes the hub", () => {
		const row = { wolf: "1uk4", id: FEATURE, title: "Live pack map" };
		o.dispatch({ type: "threads", threads: [row], now: Date.now() });
		run(0.1);
		const hub = of("feature");
		assert.equal(hub.working, false);
		assert.ok(hub.alpha > 0 && hub.alpha < 1, `dimmed (${hub.alpha})`);
		assert.ok(near([hub.x, hub.y], nodes.get("work:ELzLSkV")!, 120), "at its work node");
		mock.timers.tick(3 * 3_600_000); // no presence, hours later: the roster still holds it
		o.dispatch({ type: "tick", now: Date.now() });
		run(0.1);
		assert.ok(items().some((i) => i.kind === "feature"));
		send("thread-active", feature); // a live event upgrades it
		run(0.1);
		assert.equal(of("feature").working, true);
		o.dispatch({ type: "threads", threads: [], now: Date.now() });
		run(0.1);
		assert.equal(items().some((i) => i.kind === "feature"), false, "dropped from the roster");
	});

	it("an archived feature thread in the roster gets no hub", () => {
		o.dispatch({ type: "threads", threads: [{ wolf: "1uk4", id: FEATURE, title: "Live pack map", closed: true }], now: Date.now() });
		run(0.1);
		assert.equal(items().some((i) => i.kind === "feature"), false);
	});

	it("the chat's own event pulls the whole feature group strongly toward the target, its subagents riding on the ring, and the trail starts at the centre", () => {
		send("thread-active", feature);
		send("subagent-spawned", subTap);
		run(0.1);
		const hub0 = { x: of("feature").x, y: of("feature").y };
		const target = nodes.get("ent:kb-wolfpack-KNMBskd")!;
		const d = dist(hub0, target);
		send("kb-read", feature, ENT);
		run(8);
		const early = render().filter((s) => !s.dash && near(s.to, target, 0.5));
		assert.equal(early.length, 1);
		assert.ok(near(early[0]!.from, of("feature"), 0.5), "the trail starts at the group's centre, wherever it is now");
		run(22);
		const hub = of("feature");
		const moved = dist(hub, hub0);
		assert.ok(moved > 0.45 * d && moved < 0.62 * d, `about 0.56 of the way (${moved} of ${d})`);
		assert.ok(Math.abs(dist(of("subagent"), hub) - 28) < 3, "the subagent went with it, still on the ring");
		run(40);
		assert.ok(dist(of("feature"), hub0) < 5, "and it returns home when the hold ends");
	});

	it("a wolf's own kb-read sends it to the entry; its thread dots, its subagents and its trail move with it every frame, with the layout frozen", () => {
		const subHome = { ...subTap, parentThreadId: "1uk4/home" };
		send("thread-active", home);
		send("subagent-spawned", subHome);
		run(0.2);
		const w0 = of("wolf");
		send("kb-read", home, ENT);
		const target = nodes.get("ent:kb-wolfpack-KNMBskd")!;
		for (let i = 0; i < 40 * 20; i++) {
			run(0.05);
			const wolf = of("wolf");
			const dot = of("thread");
			assert.ok(Math.abs(dist(dot, wolf) - 23.4) < 1, `thread dot beside the wolf at frame ${i} (${dist(dot, wolf)})`);
			const sub = of("subagent");
			assert.ok(Math.abs(dist(sub, wolf) - 36.4) < 6, `subagent on its ring about the wolf at frame ${i} (${dist(sub, wolf)})`);
			if (i === 100) {
				const trail = render().filter((s) => !s.dash && near(s.to, target, 0.5));
				assert.equal(trail.length, 1);
				assert.ok(near(trail[0]!.from, wolf, 0.5), "the trail leaves the wolf where it is now");
			}
		}
		const w1 = of("wolf");
		assert.ok(dist(w0, w1) > 200 && dist(w1, target) < 30, `the wolf travelled to the entry (${dist(w1, target)})`);
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

	it("a work-touch draws a trail from the actor's body to that work item's node; a work item not on the map draws nothing, not even to its domain", () => {
		nodes.set("work:Zz9", { x: 200, y: -150, color: "#ff8844" });
		send("thread-active", feature);
		send("thread-active", home);
		send("subagent-spawned", subTap);
		run(0.1);
		const hub = of("feature");
		const sub = of("subagent");
		const toZ = () => render().filter((s) => near(s.to, nodes.get("work:Zz9")!, 0.5));
		assert.equal(toZ().length, 0);
		send("work-touch", subTap, { kind: "work-item", id: "work-wolfpack-Zz9", domain: "wolfpack" });
		send("work-touch", feature, { kind: "work-item", id: "work-wolfpack-Zz9", domain: "wolfpack" });
		run(0.05);
		const strokes = toZ();
		assert.ok(strokes.some((s) => near(s.from, hub, 6)), "a trail leaves the feature hub");
		assert.ok(strokes.some((s) => near(s.from, of("subagent"), 40) || near(s.from, sub, 40)), "a trail leaves the sub-agent");
		mock.timers.tick(60_000);
		send("work-touch", subTap, { kind: "work-item", id: "work-wolfpack-Nope", domain: "wolfpack" });
		run(0.05);
		const toDomain = render().filter((s) => near(s.to, nodes.get("dom:wolfpack")!, 0.5));
		assert.equal(toDomain.length, 0, "no fallback to the domain node");
		nodes.delete("work:Zz9");
	});

	it("reduced motion: no float, the wolf arrives at once, subagents snap to their stretch", () => {
		g.window = { matchMedia: () => ({ matches: true }), innerWidth: 1280 };
		const still = new LiveOverlay(() => {});
		still.configure(LIVE_DEFAULTS);
		send("thread-active", feature, undefined, still);
		send("thread-active", home, undefined, still);
		send("subagent-spawned", subTap, undefined, still);
		send("kb-read", subTap, ENT, still);
		send("kb-read", home, ENT, still);
		still.step(T0, 0.016, host, 1);
		const w0 = still.items(host, 1, T0).find((i) => i.kind === "wolf")!;
		const sub = still.items(host, 1, T0).find((i) => i.kind === "subagent")!;
		const hub = still.items(host, 1, T0).find((i) => i.kind === "feature")!;
		assert.ok(dist(sub, hub) > 150, `snapped out toward the entry (${dist(sub, hub)})`);
		assert.ok(dist(w0, nodes.get("ent:kb-wolfpack-KNMBskd")!) < 30, "the wolf is already at the entry");
		still.step(T0 + 30_000, 0.016, host, 1);
		const w1 = still.items(host, 1, T0 + 17_000).find((i) => i.kind === "wolf")!;
		assert.ok(dist(w0, w1) < 1e-9, "the wolf neither moves nor floats");
		assert.equal(still.needsFrames(0), false);
		still.stop();
	});

	it("a wolf with a needs-you question stays at its target however long it waits, and heads home once answered", () => {
		send("thread-active", home);
		send("kb-read", home, ENT);
		run(8);
		send("needs-you", home);
		run(120);
		const entry = nodes.get("ent:kb-wolfpack-KNMBskd")!;
		assert.ok(dist(of("wolf"), entry) < 60, `still at the entry (${dist(of("wolf"), entry)})`);
		send("answered", home);
		run(200);
		assert.ok(dist(of("wolf"), entry) > 150, `back toward the den (${dist(of("wolf"), entry)})`);
	});

	it("asks for no frames while the document is hidden, and again once it is shown", () => {
		send("thread-active", home);
		run(0.1);
		const doc = g.document;
		try {
			g.document = { hidden: true };
			assert.equal(o.needsFrames(Date.now()), false);
			g.document = { hidden: false };
			assert.equal(o.needsFrames(Date.now()), true);
		} finally {
			g.document = doc;
		}
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
