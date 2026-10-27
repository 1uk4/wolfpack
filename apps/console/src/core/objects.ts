/**
 * Structured objects in the thread view (decision now; checklist and graph add a type in the protocol's objects.ts
 * and a card in components/card-registry). PURE — no React, no IO.
 *
 * Transport: the protocol's `object-upsert` event (live) and `ThreadMessage.objects` (history/reload) — the adapter
 * and threadMessagesToNative turn both into the SAME native block, `{type:"object", objectId, objectType, rev, data}`
 * inside the assistant message (position = arrival live, `textOffset` on reload). projectView projects each block to
 * an "object" view part and `collapseObjects` folds them: per objectId the highest rev wins, shown at its FIRST
 * position; `recency` stamps the part with the ordinal of its latest upsert (recency across objects). Harness-originated revisions (no tool call) need a server-side source of upserts; they would need no
 * console change, since they arrive as the same events and history objects.
 */
import { OBJECT_TOOL_TYPES, parseObjectData, type ChecklistData } from "@wolfpack/protocol/objects";
import type { LhViewMessage, LhViewPart } from "./view.ts";

/** Names of the tools that show objects: their tool row is hidden, the card is the UX. */
export const OBJECT_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(OBJECT_TOOL_TYPES));

/** The native assistant-content block an object travels as. */
export interface ObjectBlock {
	type: "object";
	objectId: string;
	objectType: string;
	rev: number;
	data: unknown;
	/** History only: the server's thread-wide ordinal of the object's latest upsert (survives reload). */
	upsertSeq?: number;
}

export const isObjectBlock = (b: { type: string }): b is ObjectBlock => b.type === "object";

/** The view part of an object block, or undefined when its data is not valid for its type (never half-drawn). */
export function objectPartOf(block: ObjectBlock, id: string): LhViewPart | undefined {
	if (typeof block.objectId !== "string" || block.objectId === "") return undefined;
	const data = parseObjectData(block.objectType, block.data);
	return data === undefined ? undefined : { type: "object", id, objectId: block.objectId, objectType: block.objectType, rev: block.rev, data, ...(typeof block.upsertSeq === "number" ? { upsertSeq: block.upsertSeq } : {}) };
}

/**
 * Fold object parts across the whole view (in place): highest rev per objectId wins, kept at its first position.
 * Each kept part gets `recency`, the ordinal of its latest upsert: the server's thread-wide `upsertSeq` for history
 * objects (the only recency a reload keeps), else the arrival order after everything seen so far (live events).
 */
export function collapseObjects(messages: LhViewMessage[]): void {
	const first = new Map<string, LhViewPart>();
	let last = 0;
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		m.parts = m.parts.filter((p) => {
			if (p.type !== "object") return true;
			const recency = typeof p.upsertSeq === "number" ? p.upsertSeq : last + 1;
			last = Math.max(last, recency);
			const kept = first.get(p.objectId as string);
			if (!kept) {
				p.recency = recency;
				first.set(p.objectId as string, p);
				return true;
			}
			if ((p.rev as number) >= (kept.rev as number)) {
				kept.rev = p.rev;
				kept.objectType = p.objectType;
				kept.data = p.data;
				kept.recency = recency;
			}
			return false;
		});
	}
}

export interface ActiveChecklist {
	objectId: string;
	rev: number;
	data: ChecklistData;
}

/**
 * The thread's active checklist: among the folded checklist parts, the one whose latest upsert came last (`recency`).
 * A finished (all done / all skipped) checklist stays active until a newer checklist appears. Invalid data is skipped.
 */
export function activeChecklist(messages: LhViewMessage[]): ActiveChecklist | undefined {
	let best: { seq: number; value: ActiveChecklist } | undefined;
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		for (const p of m.parts) {
			if (p.type !== "object" || p.objectType !== "checklist") continue;
			const data = parseObjectData("checklist", p.data);
			const seq = typeof p.recency === "number" ? p.recency : 0;
			if (data && (!best || seq >= best.seq)) best = { seq, value: { objectId: p.objectId as string, rev: p.rev as number, data } };
		}
	}
	return best?.value;
}
