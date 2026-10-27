/**
 * THE KB / MEMORY CORE: type re-exports from @wolfpack/client plus the small
 * pure helpers the memory-visibility UI shares (librarian lookup, memory-event
 * frame parsing, hrefs, event → graph node id). Browser-safe: no zod, no IO.
 */

import type { MemoryEvent } from "@wolfpack/client";

export type {
	BoundWork,
	KbEdgeKind,
	KbEntryDetail,
	KbGraph,
	KbGraphEdge,
	KbGraphNode,
	KbNodeKind,
	LastPromote,
	MemoryEvent,
	MemoryEventType,
	MemoryPoolStatus,
	MemoryState,
	MemoryStatus,
	MemoryTarget,
	MemoryTopic,
	MemoryTopicRef,
	ConsolidateResponse,
	PromoteResponse,
	WorkRecordResponse,
} from "@wolfpack/client";

/** The pack's librarian (serves the KB), or null when none is known/flagged. */
export function findLibrarian<W extends { name: string; librarian?: boolean }>(wolves: readonly W[]): W | null {
	return wolves.find((w) => w.librarian === true) ?? null;
}

/**
 * A memory event of a type this build does not know yet (e.g. record_written,
 * topic_archived, sweep_*): kept as a loose `{ type, ...fields }` so new
 * variants flow through consumers that ignore what they don't recognise.
 */
export interface GenericMemoryEvent {
	type: string;
	[key: string]: unknown;
}

export type MemoryEventFrame = MemoryEvent | GenericMemoryEvent;

/**
 * One SSE `data:` payload → a MemoryEventFrame. Unknown event types are NOT
 * dropped: any JSON object with a string `type` and string `wolf` passes
 * through as a generic frame (consumers switch on `type` and ignore the
 * rest). Returns null only for non-JSON, non-objects, or objects missing
 * `type`/`wolf`. Never throws.
 */
export function parseMemoryEventFrame(raw: string): MemoryEventFrame | null {
	let v: unknown;
	try {
		v = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
	const o = v as Record<string, unknown>;
	if (typeof o.type !== "string" || typeof o.wolf !== "string") return null;
	return o as MemoryEventFrame;
}

export const PIPELINE_HREF = "/pipeline";
export const entryHref = (id: string): string => `/kb/entry/${encodeURIComponent(id)}`;
export const workHref = (id: string): string => `/kb/work/${encodeURIComponent(id)}`;

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
