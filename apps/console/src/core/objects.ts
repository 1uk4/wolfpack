/**
 * Structured objects in the thread view (decision now; checklist and graph add an entry to OBJECT_TOOLS).
 * PURE — no React, no IO.
 *
 * A wolf shows an object by calling its tool (`show_decision`), so every call is already a tool part in the view,
 * live (tool-start args) and from history (ThreadMessage.tools). The server derives its `object-upsert` events and
 * history `objects` from the same calls with the same rule — rev = calls so far with that objectId — so folding
 * the parts here yields the identical latest rev with no second channel to keep in sync. The object renders once,
 * at its FIRST call's position, with the latest call's data.
 */
import type { LhViewMessage, LhViewPart } from "./view.ts";

/** Tool name → object type. */
export const OBJECT_TOOLS: Readonly<Record<string, string>> = { show_decision: "decision" };

export interface DecisionOption {
	id: string;
	label: string;
	detail?: string;
}

export interface DecisionData {
	title?: string;
	options: DecisionOption[];
	chosen: string;
	rationale: string;
}

const isStr = (v: unknown): v is string => typeof v === "string";

/** Narrow `data` to a decision; undefined when it does not fit (the card is skipped, never half-drawn). */
export function parseDecisionData(data: unknown): DecisionData | undefined {
	const d = data as Partial<DecisionData> | null | undefined;
	if (!d || !isStr(d.chosen) || !isStr(d.rationale) || !Array.isArray(d.options) || d.options.length === 0) return undefined;
	const options: DecisionOption[] = [];
	for (const o of d.options as Array<Partial<DecisionOption>>) {
		if (!o || !isStr(o.id) || !isStr(o.label)) return undefined;
		options.push({ id: o.id, label: o.label, ...(isStr(o.detail) ? { detail: o.detail } : {}) });
	}
	return { ...(isStr(d.title) ? { title: d.title } : {}), options, chosen: d.chosen, rationale: d.rationale };
}

const DATA_PARSERS: Record<string, (data: unknown) => unknown> = { decision: parseDecisionData };

/** The object a tool part shows (its type, id and data), or undefined: not an object tool, still streaming, failed or invalid. */
export function objectOfPart(part: LhViewPart): { objectId: string; type: string; data: unknown } | undefined {
	if (!part.type.startsWith("tool-")) return undefined;
	const type = OBJECT_TOOLS[part.type.slice("tool-".length)];
	if (!type || part.state === "input-streaming" || part.state === "output-error") return undefined;
	const { objectId, ...rest } = (part.input ?? {}) as Record<string, unknown>;
	if (!isStr(objectId) || objectId === "") return undefined;
	const data = DATA_PARSERS[type]?.(rest);
	return data === undefined ? undefined : { objectId, type, data };
}

export const isObjectPart = (part: LhViewPart): boolean => part.type.startsWith("tool-") && part.type.slice("tool-".length) in OBJECT_TOOLS;

export interface FoldedObject {
	objectId: string;
	type: string;
	/** 1 + the number of revisions. */
	rev: number;
	data: unknown;
	/** `${messageIndex}:${partIndex}` of the first call: where the card renders. */
	at: string;
}

/** Fold every object call of the thread, in order: latest data and rev per objectId, at its first position. */
export function foldObjects(messages: readonly Pick<LhViewMessage, "role" | "parts">[]): Map<string, FoldedObject> {
	const out = new Map<string, FoldedObject>();
	messages.forEach((m, mi) => {
		if (m.role !== "assistant") return;
		m.parts.forEach((part, pi) => {
			const o = objectOfPart(part);
			if (!o) return;
			const prior = out.get(o.objectId);
			out.set(o.objectId, { ...o, rev: (prior?.rev ?? 0) + 1, at: prior?.at ?? `${mi}:${pi}` });
		});
	});
	return out;
}
