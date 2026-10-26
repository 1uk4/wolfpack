/**
 * Tool rows: the thread view's compact line per tool call. PURE — the view
 * parts (live or reloaded from history, same projection) → render entries.
 *
 * Why this exists: the thread view only rendered `tool-*` parts for tools in
 * the artifact registry (read/ls/find/grep) and printed a Separator per
 * assistant step plus a Reasoning row per thinking part, so a bash/task_*
 * round (empty thinking + an unregistered tool call) was a bare divider.
 */

import type { LhViewPart } from "./view.ts";

export type ToolStatus = "running" | "done" | "error" | "pending";

export interface ToolEntry {
	callId: string;
	name: string;
	/** One-line argument summary (truncated). */
	summary: string;
	status: ToolStatus;
	/** The result text (output, or the error text). Absent until it lands. */
	result?: string;
}

const SUMMARY_MAX = 100;

function oneLine(s: string, max = SUMMARY_MAX): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/** bash: the command; read/write/edit: the path; task_*: id/title; else the first string arg. */
export function summarizeArgs(name: string, args: unknown): string {
	const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	let s: string | undefined;
	if (name === "bash") s = str(a.command);
	else if (name === "read" || name === "write" || name === "edit") s = str(a.path) ?? str(a.file_path);
	else if (name.startsWith("task_")) s = str(a.id) ?? str(a.title);
	s ??= Object.values(a).find((v): v is string => str(v) !== undefined);
	return s ? oneLine(s) : "";
}

function resultText(out: unknown): string | undefined {
	if (out == null) return undefined;
	if (typeof out === "string") return out;
	try {
		return JSON.stringify(out, null, 2);
	} catch {
		return String(out);
	}
}

export function isToolPart(part: { type: string }): boolean {
	return part.type.startsWith("tool-");
}

/** A tool view part → its row entry. */
export function toolEntryOf(part: LhViewPart): ToolEntry {
	const name = part.type.slice("tool-".length);
	const base = { callId: part.toolCallId ?? "", name, summary: summarizeArgs(name, part.input) };
	switch (part.state) {
		case "output-available":
			return { ...base, status: "done", result: resultText(part.output) ?? "" };
		case "output-error":
			return { ...base, status: "error", result: part.errorText ?? "The tool call failed." };
		case "input-streaming":
			return { ...base, status: "running" };
		default:
			// A settled call with no result (an interrupted turn).
			return { ...base, status: "pending" };
	}
}

/** Empty or whitespace-only thinking (a signature-only block) renders nothing. */
export function isEmptyThinking(part: LhViewPart): boolean {
	return part.type === "reasoning" && (part.text ?? "").trim() === "";
}

export type RenderItem =
	| { kind: "text"; part: LhViewPart; index: number }
	| { kind: "reasoning"; part: LhViewPart; index: number }
	| { kind: "tool"; entry: ToolEntry; part: LhViewPart; index: number; key: string }
	| { kind: "separator"; index: number };

/**
 * An assistant message's parts → what the thread renders, in order.
 * - Empty thinking is dropped, unless it is the streaming placeholder (the
 *   LAST part while streaming: the "thinking…" row).
 * - A step separator is kept only between two text-bearing steps; tool rounds
 *   never get dividers.
 * - Non-tool unknown parts render nothing.
 */
export function renderItems(parts: readonly LhViewPart[], streaming: boolean): RenderItem[] {
	const items: RenderItem[] = [];
	let lastKind: RenderItem["kind"] | null = null;
	let pendingStep = false;
	const keyCounts = new Map<string, number>();
	parts.forEach((part, index) => {
		if (part.type === "step-start") {
			pendingStep = true;
			return;
		}
		let item: RenderItem | null = null;
		if (part.type === "text") item = { kind: "text", part, index };
		else if (part.type === "reasoning") {
			const placeholder = streaming && index === parts.length - 1;
			if (!isEmptyThinking(part) || placeholder) item = { kind: "reasoning", part, index };
		} else if (isToolPart(part)) {
			const entry = toolEntryOf(part);
			// React key: the callId, made unique when a record repeats one.
			const base = entry.callId || `tool-${index}`;
			const seen = keyCounts.get(base) ?? 0;
			keyCounts.set(base, seen + 1);
			item = { kind: "tool", entry, part, index, key: seen === 0 ? base : `${base}#${seen}` };
		}
		if (!item) return;
		if (pendingStep && lastKind === "text" && item.kind === "text") items.push({ kind: "separator", index });
		pendingStep = false;
		items.push(item);
		lastKind = item.kind;
	});
	return items;
}
