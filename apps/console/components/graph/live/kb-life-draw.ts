/**
 * KB LIFE drawing (world coordinates, camera applied, like the rest of the overlay): buffer rings around the wolves, gathered topic dots,
 * flights to the curator mark, the curator's shimmer, and the results (a new node / a pulse on the entry / a fade at the curator).
 * Pure function of (KbLife, clock): all state lives in src/core/graph/live/kb-life.ts. Sizes are screen px (divided by the zoom k).
 * The curator is a small mark near the KB domains (the hub has no node on the map): the middle of the domain nodes seen, eased toward
 * the graph centre, so it never sits on a domain.
 */
import { curatorBusy, displayFill, KB_FILL_EASE_MS, topicsOf, type KbFlight, type KbLife, type KbResult } from "@/src/core";
import { rgba } from "./live-effects";
import { LIVE_TUNING } from "./live-tuning";

/** The overlay unit (live-overlay OVERLAY_UNIT), duplicated to avoid a circular import. */
const KB_UNIT = 0.55;

export interface Pt { x: number; y: number }
export interface KbDrawHost {
	nodePos(id: string): Pt | null;
	hasNode(id: string): boolean;
	nodeColor(id: string): string | undefined;
	center(): Pt;
	colors: { node: string; label: string; hoverText: string };
	fontFamily: string;
}
/** What the log hovers or selects: a flying topic and / or the curator mark. */
export interface KbFocus { topicId?: string; curator?: boolean }
export interface KbWolfBody { x: number; y: number; r: number; color: string; alpha: number }

const AMBER = "#ffd166";
const smooth = (t: number) => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - 2 * c); };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** The curator IS Home: its position is the graph centre the wolves orbit. */
export function curatorPos(_kb: KbLife, host: KbDrawHost): Pt {
	return host.center();
}

/** Where a result lands: the entry's node, else its section, else its domain; null when the map has none of them. */
export function resultPos(host: KbDrawHost, r: KbResult | undefined, domain?: string): Pt | null {
	const ids = [r?.entryId ? `ent:${r.entryId}` : "", r?.section ? `sec:${r.section}` : "", (r?.domain ?? domain) ? `dom:${r?.domain ?? domain}` : ""];
	for (const id of ids) if (id && host.hasNode(id)) return host.nodePos(id);
	return null;
}

/** The inner ring round Home (kbRingPx, scaled by the overlay unit m): items circle Home here until the curator files them. */
function slotPos(cur: Pt, slot: number, wall: number, reduced: boolean, m: number): Pt {
	const a = slot * 2.4 + (reduced ? 0 : wall / 4000);
	const r = LIVE_TUNING.kbRingPx * m;
	return { x: cur.x + Math.cos(a) * r, y: cur.y + Math.sin(a) * r };
}

/** How long a new memory item takes to travel from its wolf to the ring round Home (ms). */
export const ITEM_TRAVEL_MS = 900;

/** A memory item's place: born at its wolf (`start`), eased to its slot on the inner ring round Home over ITEM_TRAVEL_MS, then orbiting there. Reduced motion: on the ring at once. */
export function itemPos(start: Pt, cur: Pt, slot: number, born: number, wall: number, m: number, reduced: boolean): Pt {
	const ring = slotPos(cur, slot, wall, reduced, m);
	if (reduced) return ring;
	const t = smooth((wall - born) / ITEM_TRAVEL_MS);
	return { x: lerp(start.x, ring.x, t), y: lerp(start.y, ring.y, t) };
}

export function drawKbLife(ctx: CanvasRenderingContext2D, kb: KbLife, host: KbDrawHost, wolfOf: (name: string) => KbWolfBody | undefined, k: number, wall: number, reduced: boolean, focus: KbFocus | null, m = KB_UNIT): void {
	const cur = curatorPos(kb, host);
	const busy = curatorBusy(kb);
	const hasLife = Object.keys(kb.wolves).length > 0 || kb.flights.length > 0 || kb.pulses.length > 0 || Object.keys(kb.curator).length > 0;
	if (!hasLife) return;
	ctx.save();
	ctx.lineCap = "round";

	let shown = 0;
	// Buffer rings: a thin arc around each wolf, fill = tokens / capacity, easing when it changes.
	for (const [name, w] of Object.entries(kb.wolves)) {
		const b = wolfOf(name);
		if (!b) continue;
		const rr = b.r + 5 / k;
		ctx.globalAlpha = b.alpha;
		ctx.lineWidth = 2.2 / k;
		ctx.strokeStyle = rgba(b.color, 0.18);
		ctx.beginPath();
		ctx.arc(b.x, b.y, rr, 0, Math.PI * 2);
		ctx.stroke();
		const f = displayFill(w, wall);
		if (f > 0.004) {
			ctx.strokeStyle = rgba(b.color, 0.9);
			ctx.beginPath();
			ctx.arc(b.x, b.y, rr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, f));
			ctx.stroke();
		}
		// Consolidate: the ring drains into the topic dots (a short bright flash while it empties).
		if (!reduced && w.fill === 0 && wall - w.changedAt < KB_FILL_EASE_MS && w.prevFill > 0) {
			ctx.strokeStyle = rgba(b.color, 0.5 * (1 - (wall - w.changedAt) / KB_FILL_EASE_MS));
			ctx.beginPath();
			ctx.arc(b.x, b.y, rr + 2 / k, 0, Math.PI * 2);
			ctx.stroke();
		}
		ctx.globalAlpha = 1;
		// Topic dots gather on the inner ring round Home (about kbMaxItems visible), in the wolf's colour.
		const topics = topicsOf(kb, name);
		topics.forEach((t, i) => {
			// Born at the wolf and flown to Home; items past the cap wait beside their wolf.
			const p = shown >= LIVE_TUNING.kbMaxItems ? beside(b, i, k) : itemPos({ x: b.x, y: b.y }, cur, t.slot, t.born, wall, m, reduced);
			if (shown < LIVE_TUNING.kbMaxItems) shown++;
			const grow = reduced ? smooth((wall - t.born) / 400) : 1;
			ctx.fillStyle = rgba(b.color, 0.85 * b.alpha);
			ctx.beginPath();
			ctx.arc(p.x, p.y, (4 * grow) / k, 0, Math.PI * 2);
			ctx.fill();
			if (focus?.topicId === t.id) ring(ctx, p, 7 / k, host.colors.hoverText, k);
		});
	}

	// Home is the curator: no mark of its own, just the amber shimmer round the Home disc while it works.
	const hr = LIVE_TUNING.denRadiusPx * m;
	if (busy) {
		const a = reduced ? 0 : wall / 420;
		ctx.lineWidth = 2 / k;
		ctx.strokeStyle = rgba(AMBER, 0.9);
		ctx.beginPath();
		ctx.arc(cur.x, cur.y, hr + 3 / k, a, a + (reduced ? Math.PI * 2 : 1.7));
		ctx.stroke();
		if (!reduced) {
			const g = 0.5 + 0.5 * Math.sin(wall / 260);
			ctx.fillStyle = rgba(AMBER, 0.08 + 0.1 * g);
			ctx.beginPath();
			ctx.arc(cur.x, cur.y, hr + (6 + 4 * g) / k, 0, Math.PI * 2);
			ctx.fill();
		}
	}
	if (focus?.curator) ring(ctx, cur, hr + 8 / k, host.colors.hoverText, k);

	// Flights.
	const queuedIdx = new Map<string, number>();
	for (const f of kb.flights) {
		const body = f.wolf ? wolfOf(f.wolf) : undefined;
		const color = body?.color ?? host.nodeColor(`dom:${f.domain ?? f.result?.domain ?? ""}`) ?? host.colors.node;
		let idx = 0;
		if (f.stage === "queued") {
			idx = (queuedIdx.get(f.wolf) ?? 0) + topicsOf(kb, f.wolf).length;
			queuedIdx.set(f.wolf, (queuedIdx.get(f.wolf) ?? 0) + 1);
		}
		const start = body ? beside(body, idx, k) : cur;
		const p = flightPos(f, start, cur, resultPos(host, f.result, f.domain), wall, k, reduced, m);
		if ((f.stage !== "queued" || f.born !== undefined) && f.stage !== "fade" && shown++ >= LIVE_TUNING.kbMaxItems) continue;
		const alpha = f.stage === "fade" ? 1 - smooth((wall - f.at) / Math.max(1, f.endAt - f.at)) : 1;
		const r = 4.2 / k;
		if (!reduced) {
			const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3);
			g.addColorStop(0, rgba(color, 0.5 * alpha));
			g.addColorStop(1, rgba(color, 0));
			ctx.fillStyle = g;
			ctx.beginPath();
			ctx.arc(p.x, p.y, r * 3, 0, Math.PI * 2);
			ctx.fill();
		}
		ctx.fillStyle = rgba(color, alpha);
		ctx.beginPath();
		ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
		ctx.fill();
		if (focus?.topicId === f.id) ring(ctx, p, 9 / k, host.colors.hoverText, k);
	}

	// Results: a create grows a node at its section; a merge pulses the entry.
	for (const pl of kb.pulses) {
		const at = resultPos(host, { outcome: pl.kind, ...(pl.entryId ? { entryId: pl.entryId } : {}), ...(pl.section ? { section: pl.section } : {}), ...(pl.domain ? { domain: pl.domain } : {}) }, pl.domain);
		if (!at) continue;
		const color = host.nodeColor(`dom:${pl.domain ?? ""}`) ?? host.colors.node;
		const u = reduced ? 0.4 : Math.max(0, Math.min(1, (wall - pl.at) / 2600));
		ctx.lineWidth = 1.6 / k;
		ctx.strokeStyle = rgba(color, 0.8 * (1 - u));
		ctx.beginPath();
		ctx.arc(at.x, at.y, (6 + u * 18) / k, 0, Math.PI * 2);
		ctx.stroke();
		if (pl.kind === "create" && !pl.entryId) {
			// the map has no node for it yet (the graph refreshes later): a temporary dot stands for it
			ctx.fillStyle = rgba(color, 0.9 * (1 - u * 0.5));
			ctx.beginPath();
			ctx.arc(at.x + 10 / k, at.y - 8 / k, (3.6 * smooth(u * 4)) / k, 0, Math.PI * 2);
			ctx.fill();
		}
	}
	ctx.restore();
}

function beside(b: KbWolfBody, i: number, k: number): Pt {
	const a = 0.35 + i * 0.5;
	const d = b.r + 18 / k;
	return { x: b.x + Math.cos(a) * d, y: b.y + Math.sin(a) * d };
}

function ring(ctx: CanvasRenderingContext2D, p: Pt, r: number, color: string, k: number): void {
	ctx.lineWidth = 1.5 / k;
	ctx.strokeStyle = rgba(color, 0.85);
	ctx.beginPath();
	ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
	ctx.stroke();
}

/** Where a flight is at `wall` (exported for the draw tests). */
export function flightPos(f: KbFlight, start: Pt, cur: Pt, target: Pt | null, wall: number, k: number, reduced: boolean, m = KB_UNIT): Pt {
	const slot = slotPos(cur, f.slot, wall, reduced, m);
	// A flight made from a topic dot that reached the ring carries on from that place (no second trip from the wolf).
	if (f.born !== undefined && (f.stage === "queued" || f.stage === "travel")) return itemPos(start, cur, f.slot, f.born, wall, m, reduced);
	switch (f.stage) {
		case "queued":
			return start;
		case "travel": {
			const t = smooth((wall - f.at) / Math.max(1, f.endAt - f.at));
			const dx = slot.x - start.x;
			const dy = slot.y - start.y;
			const len = Math.hypot(dx, dy) || 1;
			const bow = reduced ? 0 : Math.sin(Math.PI * t) * 28 / k;
			return { x: lerp(start.x, slot.x, t) - (dy / len) * bow, y: lerp(start.y, slot.y, t) + (dx / len) * bow };
		}
		case "place": {
			const to = target ?? { x: cur.x + 40 / k, y: cur.y - 30 / k };
			const t = smooth((wall - f.at) / Math.max(1, f.endAt - f.at));
			return { x: lerp(slot.x, to.x, t), y: lerp(slot.y, to.y, t) };
		}
		default:
			return slot;
	}
}
