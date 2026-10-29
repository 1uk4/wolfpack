/**
 * GRADUATING FROM THE APP (pure, browser-safe): when a feature may graduate and why not, and which wolf runs it.
 * Graduation turns a finished feature into KB entries (outward-impacting), so the button only enables on a feature
 * that is ready, and the wolf that runs it is the assignee's when that wolf is online, else the owner's pick.
 */

export interface GraduateState {
	/** A graduate button belongs on this item at all (a live, non-container feature). */
	show: boolean;
	ready: boolean;
	/** Why it is disabled ("2 tasks open"); "" when ready. */
	reason: string;
}

const COMPLETE = new Set(["shipped", "live", "archived"]);

export const NO_GRADUATE: GraduateState = { show: false, ready: false, reason: "" };

/**
 * Mirrors the wolf's readiness check: a feature graduates once it has tasks and all of them are complete. With the
 * tasks unknown (a payload that did not carry them) a shipped feature counts as ready, which is what the Work API
 * moves such a feature to; the wolf re-checks anyway and refuses with its own reason.
 */
export function featureGraduateState(
	item: { kind: string; stage: string; graduated?: boolean; container?: boolean },
	tasks: readonly { stage: string }[] | null,
): GraduateState {
	if (item.kind !== "feature" || item.container || item.graduated || item.stage === "archived") return NO_GRADUATE;
	if (tasks === null) {
		const ready = item.stage === "shipped" || item.stage === "live";
		return { show: true, ready, reason: ready ? "" : "not shipped yet" };
	}
	if (tasks.length === 0) return { show: true, ready: false, reason: "no tasks yet" };
	const open = tasks.filter((t) => !COMPLETE.has(t.stage)).length;
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
