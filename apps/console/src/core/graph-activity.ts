/**
 * Live graph activity: which graph nodes a memory event is about, and the
 * burst coalescer the graph home feeds them through. Pure.
 *
 * Ids follow the graph: `ent:<id>` (KB entry), `work:<id>` (work item),
 * `den:<wolf>:<topic>` (den topic). Only ids present in the graph are
 * returned, so the caller can pulse blindly.
 */
import type { KbGraph, MemoryEventFrame } from "./kb.ts";

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** Node ids an event names, whether or not the graph has them yet. */
export function eventNodeIds(event: MemoryEventFrame): string[] {
	const o = event as Record<string, unknown>;
	const wolf = str(o.wolf);
	const target = o.target as { kind?: string; topicId?: string; workId?: string } | undefined;
	const out: string[] = [];
	const den = (w: string | undefined, topic: string | undefined) => {
		if (w && topic) out.push(`den:${w}:${topic}`);
	};
	switch (o.type) {
		case "observation_captured":
			if (target?.kind === "work" && target.workId) out.push(`work:${target.workId}`);
			else if (target?.kind === "den") den(wolf, target.topicId);
			break;
		case "record_written": {
			const w = target?.kind === "work" ? target.workId : str(o.workId);
			if (w) out.push(`work:${w}`);
			break;
		}
		case "topic_archived": {
			const into = str(o.absorbedInto);
			if (into) out.push(`ent:${into}`);
			den(wolf, str(o.topicId) ?? target?.topicId);
			break;
		}
		case "sweep_item": {
			const entry = str(o.entryId);
			if (entry) out.push(`ent:${entry}`);
			den(str(o.from), str(o.denTopicId));
			break;
		}
		case "topic_consolidated":
			if (target?.kind === "den") den(wolf, str(o.topicId));
			break;
		default:
			break;
	}
	return [...new Set(out)];
}

/** The named nodes that exist in the graph. */
export function pulseTargets(event: MemoryEventFrame, graph: Pick<KbGraph, "nodes"> | null): string[] {
	if (!graph) return [];
	const present = new Set(graph.nodes.map((n) => n.id));
	return eventNodeIds(event).filter((id) => present.has(id));
}

export const PENDING_PULSE_TTL_MS = 10_000;
export const PENDING_PULSE_MAX = 50;

/** Ids for nodes that don't exist yet (a sweep just created the entry):
 *  held briefly, handed out when a later graph has them. Bounded. */
export function createPendingPulses(ttlMs = PENDING_PULSE_TTL_MS, max = PENDING_PULSE_MAX) {
	const held = new Map<string, number>();
	return {
		add(ids: readonly string[], now: number) {
			for (const id of ids) {
				held.delete(id);
				held.set(id, now + ttlMs);
			}
			while (held.size > max) held.delete(held.keys().next().value as string);
		},
		/** Ids now present in `graph`; removes them and any expired ones. */
		take(graph: Pick<KbGraph, "nodes">, now: number): string[] {
			const present = new Set(graph.nodes.map((n) => n.id));
			const out: string[] = [];
			for (const [id, exp] of held) {
				if (exp <= now) held.delete(id);
				else if (present.has(id)) {
					held.delete(id);
					out.push(id);
				}
			}
			return out;
		},
		size: () => held.size,
	};
}

/** Trailing debounce; each call restarts the wait. */
export function createDebounce(
	fn: () => void,
	ms: number,
	timers: { set: (f: () => void, ms: number) => unknown; clear: (h: unknown) => void } = {
		set: (f, d) => setTimeout(f, d),
		clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
	},
) {
	let handle: unknown = null;
	return {
		call() {
			if (handle !== null) timers.clear(handle);
			handle = timers.set(() => {
				handle = null;
				fn();
			}, ms);
		},
		cancel() {
			if (handle !== null) timers.clear(handle);
			handle = null;
		},
	};
}

/** Collects ids over `windowMs` and hands them over once, de-duplicated
 *  (a burst of events becomes one pulse call). */
export function createPulseBatcher(
	flush: (ids: string[]) => void,
	windowMs = 150,
	timers: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void } = {
		set: (fn, ms) => setTimeout(fn, ms),
		clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
	},
) {
	let pending = new Set<string>();
	let handle: unknown = null;
	const run = () => {
		handle = null;
		const ids = [...pending];
		pending = new Set();
		if (ids.length > 0) flush(ids);
	};
	return {
		add(ids: readonly string[]) {
			if (ids.length === 0) return;
			for (const id of ids) pending.add(id);
			if (handle === null) handle = timers.set(run, windowMs);
		},
		cancel() {
			if (handle !== null) timers.clear(handle);
			handle = null;
			pending = new Set();
		},
	};
}

/** The most online wolves the graph subscribes to (one SSE each). */
export const MAX_ACTIVITY_WOLVES = 5;

/** Wolves to listen to: the librarian first, then online wolves, capped. */
export function activityWolves(
	librarian: string | null,
	wolves: readonly { name: string; status: string }[],
	cap = MAX_ACTIVITY_WOLVES,
): string[] {
	const out: string[] = librarian ? [librarian] : [];
	for (const w of wolves) {
		if (out.length >= cap) break;
		if (w.status !== "offline" && !out.includes(w.name)) out.push(w.name);
	}
	return out;
}
