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
	MemoryObservation,
	MemoryObservations,
	MemoryTopic,
	MemoryTopicRef,
	ConsolidateResponse,
	PromoteResponse,
	WorkRecordResponse,
	WorkListItem,
	WorkListResponse,
	GraduationPreview,
	GraduationContribution,
	GraduationResult,
	GraduationJob,
	GraduationStatus,
	GraduationObservations,
} from "@wolfpack/client";

/** The pack's librarian (serves the KB), or null when none is known/flagged. */
export function findLibrarian<W extends { name: string; librarian?: boolean }>(wolves: readonly W[]): W | null {
	return wolves.find((w) => w.librarian === true) ?? null;
}

/** Where the KB graph and entries are read from: the wolf, and whether it is a read-only mirror (not the librarian). */
export interface KbSource {
	name: string;
	mirror: boolean;
}

/**
 * The KB source: the librarian when it is online, else the first online wolf that can read the KB (kbReadable,
 * a Syncthing mirror), else null. Only for the read-only graph/entry routes; the pipeline and sweep need the librarian.
 */
export function findKbSource<W extends { name: string; status?: string; librarian?: boolean; kbReadable?: boolean }>(wolves: readonly W[]): KbSource | null {
	const online = wolves.filter((w) => w.status !== "offline");
	const lib = online.find((w) => w.librarian === true);
	if (lib) return { name: lib.name, mirror: false };
	const mirror = online.find((w) => w.kbReadable === true);
	return mirror ? { name: mirror.name, mirror: true } : null;
}

/** The label shown when the KB is read from a wolf other than the librarian. */
export const KB_MIRROR_LABEL = "read-only mirror (librarian offline)";

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
