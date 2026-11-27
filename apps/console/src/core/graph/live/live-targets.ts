/**
 * Which graph node an activity target means, and which thread the owner is viewing (pure).
 * Graph node ids: `ent:<entryId>`, `work:<workId>`, `sec:<sectionId>`, `dom:<domain>`.
 * Work ids may arrive as `work-<domain>-<short>` (the console's full form) or the bare/raw id the graph keys by; both are tried.
 * Fallback: the target's domain node, so a pulse still lands somewhere sensible when the exact node is not in the (filtered) graph.
 */
import type { LiveState } from "./live-state.ts";
import { threadKey } from "./thread-key.ts";

export function targetNodeId(target: { kind: string; id: string; domain?: string }, has: (nodeId: string) => boolean): string | null {
	const cands: string[] = [];
	if (target.kind === "kb-entry") cands.push(`ent:${target.id}`);
	else if (target.kind === "kb-section") cands.push(`sec:${target.id}`);
	else if (target.kind === "domain") cands.push(`dom:${target.id}`);
	else if (target.kind === "work-item") {
		const m = /^work-[a-z0-9]+-(.+)$/i.exec(target.id);
		cands.push(`work:${target.id}`);
		if (m) cands.push(`work:${m[1]}`);
	}
	for (const c of cands) if (has(c)) return c;
	if (target.domain && has(`dom:${target.domain}`)) return `dom:${target.domain}`;
	return null;
}

/** A wolfd thread id (`1uk4/feature-x`) or a URL slug (`feature-x`) reduced to the slug, so the two compare equal. */
export function threadSlugOf(wolf: string, id: string): string {
	return id.startsWith(`${wolf}/`) ? id.slice(wolf.length + 1) : id;
}

/**
 * The one thing the you node links to: the hub of the thread the floating chat is attached to (a feature thread), else the wolf's body.
 * No history: a swapped chat moves the link at once and nothing of the old one stays (work-wolfpack-mnAxvBe).
 */
export function youLinkTarget<T extends { wolf: string; threadId?: string }>(
	attached: { wolf: string; threadId: string } | null,
	featureHubs: Iterable<T>,
	wolfBody: (wolf: string) => T | undefined,
): T | undefined {
	if (!attached) return undefined;
	const slug = threadSlugOf(attached.wolf, attached.threadId);
	for (const h of featureHubs) if (h.wolf === attached.wolf && threadSlugOf(attached.wolf, h.threadId ?? "") === slug) return h;
	return wolfBody(attached.wolf);
}

/**
 * The key (in `state.threads`) of the thread the owner is viewing, or null.
 * The protocol's target has no wolf field, so the console encodes a thread target's id as `<wolf>/<slug>` (see targetFromPath).
 * A bare slug (an older console) matches only when exactly one wolf has a thread with that slug; two would be ambiguous.
 */
export function ownerThreadKey(s: LiveState): string | null {
	const v = s.owner?.viewing;
	if (!v || v.kind !== "thread") return null;
	const cut = v.id.indexOf("/");
	const wolf = cut > 0 ? v.id.slice(0, cut) : undefined;
	const slug = cut > 0 ? v.id.slice(cut + 1) : v.id;
	const hits = Object.entries(s.threads).filter(([, t]) => (wolf === undefined || t.wolf === wolf) && threadKey(t.wolf, t.id) === threadKey(t.wolf, slug));
	return hits.length === 1 ? hits[0]![0] : null;
}
