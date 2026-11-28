/**
 * The Home orbit (work-wolfpack-W24l0C6): helpers the KB life drawing uses for entries that wait at Home (the curator) and for entries
 * tied to a work item. Pure functions plus two small draws; the state lives in src/core kb-life.ts.
 *  - a work-record save flies from its wolf to the feature's node and fades there (never to Home);
 *  - a graduation starts at the feature's node and joins the Home orbit, marked with a ring;
 *  - the orbit shows at most `max` dots, the rest is a "+N" count.
 */
import { targetNodeId, type KbFlight } from "@/src/core";
import { rgba } from "./live-effects";
import type { KbDrawHost, Pt } from "./kb-life-draw";

/** The work node on the map a flight is tied to (work-record save or graduation), or null when the map does not show it. */
export function flightWorkPos(host: Pick<KbDrawHost, "hasNode" | "nodePos">, f: Pick<KbFlight, "workItem" | "domain">): Pt | null {
	if (!f.workItem) return null;
	const id = targetNodeId({ kind: "work-item", id: f.workItem, ...(f.domain ? { domain: f.domain } : {}) }, (n) => host.hasNode(n));
	return id && id.startsWith("work:") ? host.nodePos(id) : null;
}

/** How many entries wait beyond the `max` the orbit draws (0 when they all fit). */
export const orbitOverflow = (waiting: number, max: number): number => Math.max(0, waiting - max);

/** The mark of a graduated entry: a thin ring round its dot. */
export function drawGraduatedMark(ctx: CanvasRenderingContext2D, p: Pt, k: number, color: string): void {
	ctx.lineWidth = 1.2 / k;
	ctx.strokeStyle = rgba(color, 0.9);
	ctx.beginPath();
	ctx.arc(p.x, p.y, 7 / k, 0, Math.PI * 2);
	ctx.stroke();
}

/** A work-record save's place: from its wolf to the feature's node over its travel, then at the node while it fades. */
export function workFlightPos(f: Pick<KbFlight, "stage" | "at" | "endAt">, start: Pt, node: Pt, wall: number): Pt {
	if (f.stage === "queued") return start;
	if (f.stage !== "travel") return node;
	const t = Math.max(0, Math.min(1, (wall - f.at) / Math.max(1, f.endAt - f.at)));
	const e = t * t * (3 - 2 * t);
	return { x: start.x + (node.x - start.x) * e, y: start.y + (node.y - start.y) * e };
}

/** "+N" beside Home: entries waiting past the orbit's cap. */
export function drawOrbitOverflow(ctx: CanvasRenderingContext2D, cur: Pt, extra: number, k: number, r: number, color: string, font: string): void {
	if (extra <= 0) return;
	ctx.fillStyle = color;
	ctx.font = `600 ${10 / k}px ${font}`;
	ctx.textAlign = "left";
	ctx.textBaseline = "middle";
	ctx.fillText(`+${extra}`, cur.x + r + 6 / k, cur.y - r);
}
