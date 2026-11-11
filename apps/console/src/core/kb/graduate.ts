/**
 * GRADUATING FROM THE APP (pure, browser-safe): when a feature may graduate and why not, and which wolf runs it.
 * Graduation turns a finished feature into KB entries (outward-impacting), so the button only enables on a feature
 * that is ready, and the wolf that runs it is the assignee's when that wolf is online, else the owner's pick.
 */

export interface GraduateState {
	/** A graduate button belongs on this item at all (feature, initiative or loose task/issue/spike). */
	show: boolean;
	ready: boolean;
	/** Why it is disabled ("2 tasks open"); "" when ready. */
	reason: string;
}

const COMPLETE = new Set(["shipped", "live", "archived"]);

export const NO_GRADUATE: GraduateState = { show: false, ready: false, reason: "" };

const STANDALONE = new Set(["task", "issue", "spike"]);

/**
 * Mirrors the wolf's readiness rule (packages/memory/src/work/graduate.ts `readyToGraduate` / `readinessOf`; a console
 * copy, because the console bundle cannot import @wolfpack/memory). `kids` are the item's children, `parent` its parent
 * (null: none).
 *  feature     has tasks and all are complete. With the tasks unknown (`kids` null) a shipped feature counts as ready,
 *              which is what the Work API moves such a feature to; the wolf re-checks anyway.
 *  initiative  not standing, has features and all graduated. Unknown children: no button.
 *  task/issue/spike  complete and loose (no parent, or under a container such as the Inbox). Not complete, or inside a
 *              feature (it graduates with its feature): no button at all.
 */
export function graduateState(
	item: { kind: string; stage: string; graduated?: boolean; container?: boolean; standing?: boolean },
	kids: readonly { stage: string; kind?: string; graduated?: boolean }[] | null,
	parent: { container?: boolean } | null = null,
): GraduateState {
	if (item.container || item.graduated || item.stage === "archived") return NO_GRADUATE;
	if (STANDALONE.has(item.kind)) {
		return COMPLETE.has(item.stage) && (!parent || parent.container) ? { show: true, ready: true, reason: "" } : NO_GRADUATE;
	}
	if (item.kind === "initiative") {
		if (item.standing || kids === null) return NO_GRADUATE;
		const features = kids.filter((k) => k.kind === "feature");
		if (features.length === 0) return { show: true, ready: false, reason: "no features yet" };
		const open = features.filter((f) => !f.graduated).length;
		return open > 0 ? { show: true, ready: false, reason: `${open} feature${open === 1 ? "" : "s"} not graduated` } : { show: true, ready: true, reason: "" };
	}
	if (item.kind !== "feature") return NO_GRADUATE;
	if (kids === null) {
		const ready = item.stage === "shipped" || item.stage === "live";
		return { show: true, ready, reason: ready ? "" : "not shipped yet" };
	}
	if (kids.length === 0) return { show: true, ready: false, reason: "no tasks yet" };
	const open = kids.filter((t) => !COMPLETE.has(t.stage)).length;
	if (open > 0) return { show: true, ready: false, reason: `${open} task${open === 1 ? "" : "s"} open` };
	return { show: true, ready: true, reason: "" };
}

export type WolfChoice =
	/** The assignee is an online wolf: it runs the graduation. */
	| { kind: "assignee"; wolf: string }
	/** The assignee is offline or not a wolf: the owner picks one of these online wolves first. */
	| { kind: "pick"; online: string[] };

export function graduationWolf(assignee: string | undefined, wolves: readonly { name: string; status: string }[]): WolfChoice {
	// A busy wolf (mid-turn) still runs a graduation job; only "offline" is excluded.
	const online = wolves.filter((w) => w.status !== "offline").map((w) => w.name);
	if (assignee && online.includes(assignee)) return { kind: "assignee", wolf: assignee };
	return { kind: "pick", online };
}
