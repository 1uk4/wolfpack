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
	/** The full, untrimmed command (bash only): the summary drops a leading `cd <path> &&`. */
	command?: string;
}

const SUMMARY_MAX = 100;

function oneLine(s: string, max = SUMMARY_MAX): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/** A workspace prefix (`cd <path> && ` / `cd <path>; `) says nothing about the command: drop it from the summary. */
export function stripCd(command: string): string {
	const prefix = /^\s*cd\s+(?:"(?:[^"\\]|\\.)*"|'[^']*'|(?:[^\s;&|\\]|\\.)+)\s*(?:&&|;)\s*/;
	let out = command;
	for (let m = prefix.exec(out); m && out.length > m[0].length; m = prefix.exec(out)) out = out.slice(m[0].length);
	return out;
}

/** bash: the command; read/write/edit: the path; task_*: id/title; else the first string arg. */
export function summarizeArgs(name: string, args: unknown): string {
	const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	let s: string | undefined;
	if (name === "bash") {
		const cmd = str(a.command);
		s = cmd && (str(stripCd(cmd)) ?? cmd);
	}
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
	const command = name === "bash" ? str((part.input as { command?: unknown } | undefined)?.command) : undefined;
	const base = { callId: part.toolCallId ?? "", name, summary: summarizeArgs(name, part.input), ...(command ? { command } : {}) };
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
	| { kind: "group"; entries: ToolEntry[]; items: ToolItem[]; index: number; key: string }
	| { kind: "separator"; index: number };

export type ToolItem = Extract<RenderItem, { kind: "tool" }>;

/** The collapsed line of a run of calls: per-name counts, the call to show, and the overall status. */
export function summarizeGroup(entries: readonly ToolEntry[]): { counts: Array<{ name: string; count: number }>; latest: ToolEntry; status: ToolStatus } {
	const counts: Array<{ name: string; count: number }> = [];
	for (const e of entries) {
		const c = counts.find((x) => x.name === e.name);
		if (c) c.count++;
		else counts.push({ name: e.name, count: 1 });
	}
	const latest = [...entries].reverse().find((e) => e.status === "running") ?? entries[entries.length - 1]!;
	const status: ToolStatus = entries.some((e) => e.status === "running")
		? "running"
		: entries.some((e) => e.status === "error")
			? "error"
			: entries.every((e) => e.status === "pending")
				? "pending"
				: "done";
	return { counts, latest, status };
}

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
	return groupRuns(items);
}

/** Consecutive tool items (nothing rendered between them) of two or more become ONE group. */
function groupRuns(items: RenderItem[]): RenderItem[] {
	const out: RenderItem[] = [];
	let run: ToolItem[] = [];
	const flush = () => {
		if (run.length === 1) out.push(run[0]!);
		else if (run.length > 1) out.push({ kind: "group", entries: run.map((r) => r.entry), items: run, index: run[0]!.index, key: `group:${run[0]!.key}` });
		run = [];
	};
	for (const item of items) {
		if (item.kind === "tool") run.push(item);
		else {
			flush();
			out.push(item);
		}
	}
	flush();
	return out;
}

/**
 * Layout contract for assistant prose between tool rows. MessageContent is a
 * `w-fit` flex column with `overflow-hidden`: without `min-w-0` + wrapping on
 * each block, a long unbroken run sizes the column past the window and the
 * paragraph is clipped at the edge instead of wrapping.
 */
export const PROSE_BLOCK_CLASS =
	"min-w-0 max-w-full break-words [&_pre]:[overflow-wrap:normal] [&_table]:[overflow-wrap:normal] [&_code]:[overflow-wrap:normal]";
export const ASSISTANT_CONTENT_CLASS = "w-full min-w-0 max-w-full";

/**
 * Expand state lives in one map keyed by row key, so it survives a lone row
 * becoming part of a group when the next call arrives: a group with no state
 * of its own inherits its first row's.
 */
export function runOpen(open: Readonly<Record<string, boolean>>, key: string, firstRowKey?: string): boolean {
	return open[key] ?? (firstRowKey === undefined ? undefined : open[firstRowKey]) ?? false;
}
