/**
 * ACTIVITY PANEL (pure): the unseen-event badge, the replay target choice, the /kb-activity redirects and the panel's box (desktop floating panel
 * or phone bottom sheet). No DOM: storage is passed in.
 */
export const SEEN_KEY = "wolfpack.graph.activity.seenUpTo";
interface Store {
	getItem(k: string): string | null;
	setItem(k: string, v: string): void;
}

export function loadSeenUpTo(s: Store | null): number {
	try {
		const n = Number(s?.getItem(SEEN_KEY));
		return Number.isFinite(n) && n > 0 ? n : 0;
	} catch {
		return 0;
	}
}
export function saveSeenUpTo(s: Store | null, at: number): void {
	try {
		s?.setItem(SEEN_KEY, String(at));
	} catch {
		/* storage blocked */
	}
}
/** Events that arrived after the seen-up-to mark. */
export const unseenCount = (events: readonly { at: number }[], seenUpTo: number): number => events.filter((e) => e.at > seenUpTo).length;

/** Where replaying a filed entry flies: the entry node, else the deepest section of its path that is on the map, else its domain. [] = nowhere. */
export function replayTargetIds(onMap: ReadonlySet<string>, target: { kind: string; id: string; domain?: string }, sectionPath?: readonly string[]): string[] {
	if (target.kind !== "kb-entry") return [];
	if (onMap.has(`ent:${target.id}`)) return [`ent:${target.id}`];
	for (let i = (sectionPath?.length ?? 0) - 1; i >= 0; i--) if (onMap.has(`sec:${sectionPath![i]}`)) return [`sec:${sectionPath![i]}`];
	if (target.domain && onMap.has(`dom:${target.domain}`)) return [`dom:${target.domain}`];
	return [];
}

/** next.config redirects: the old KB Activity page opens the graph's Activity panel on the KB tab (a `domain` query rides along). */
export function activityRedirects(): { source: string; has?: { type: "query"; key: string; value: string }[]; destination: string; permanent: boolean }[] {
	return [
		{ source: "/kb-activity", has: [{ type: "query", key: "domain", value: "(?<domain>.+)" }], destination: "/graph?activity=kb&domain=:domain", permanent: false },
		{ source: "/kb-activity", destination: "/graph?activity=kb", permanent: false },
	];
}

/** The panel's `bottom` (CSS calc body) and smallest control size. Phone: a sheet ending above the collapsed chat icon (48px + 8px margin + 8px gap). */
export function activityPanelBox(phone: boolean): { kind: "sheet" | "panel"; bottom: string; minTarget: number } {
	return phone
		? { kind: "sheet", bottom: "env(safe-area-inset-bottom) + 64px", minTarget: 44 }
		: { kind: "panel", bottom: "var(--chat-bar-top,0px) + 12px", minTarget: 28 };
}
