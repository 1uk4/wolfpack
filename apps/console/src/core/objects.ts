/**
 * Structured objects in the thread view (decision now; checklist and graph add a type in the protocol's objects.ts
 * and a card in components/card-registry). PURE — no React, no IO.
 *
 * Transport: the protocol's `object-upsert` event (live) and `ThreadMessage.objects` (history/reload) — the adapter
 * and threadMessagesToNative turn both into the SAME native block, `{type:"object", objectId, objectType, rev, data}`
 * inside the assistant message (position = arrival live, `textOffset` on reload). projectView projects each block to
 * an "object" view part and `collapseObjects` folds them: per objectId the highest rev wins, shown at its FIRST
 * position. Harness-originated revisions (no tool call) need a server-side source of upserts; they would need no
 * console change, since they arrive as the same events and history objects.
 */
import { OBJECT_TOOL_TYPES, parseObjectData } from "@wolfpack/protocol/objects";
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
}

export const isObjectBlock = (b: { type: string }): b is ObjectBlock => b.type === "object";

/** The view part of an object block, or undefined when its data is not valid for its type (never half-drawn). */
export function objectPartOf(block: ObjectBlock, id: string): LhViewPart | undefined {
	if (typeof block.objectId !== "string" || block.objectId === "") return undefined;
	const data = parseObjectData(block.objectType, block.data);
	return data === undefined ? undefined : { type: "object", id, objectId: block.objectId, objectType: block.objectType, rev: block.rev, data };
}

/** Fold object parts across the whole view (in place): highest rev per objectId wins, kept at its first position. */
export function collapseObjects(messages: LhViewMessage[]): void {
	const first = new Map<string, LhViewPart>();
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		m.parts = m.parts.filter((p) => {
			if (p.type !== "object") return true;
			const kept = first.get(p.objectId as string);
			if (!kept) {
				first.set(p.objectId as string, p);
				return true;
			}
			if ((p.rev as number) >= (kept.rev as number)) {
				kept.rev = p.rev;
				kept.objectType = p.objectType;
				kept.data = p.data;
			}
			return false;
		});
	}
}
