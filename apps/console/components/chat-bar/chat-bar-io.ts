import { threadBase } from "@/components/thread/thread-transport";
import { threadHref, type AttachedRef } from "@/src/core";

/** What a send does: a running turn takes the message as a steer, an idle thread starts a turn. */
export const whenBusyFor = (working: boolean): "steer" | "reject" => (working ? "steer" : "reject");

/** POST the message to the thread's submit route. A 409 on an optimistic idle (the turn started meanwhile) retries once as a steer. */
export async function submitToThread(
	ref: Pick<AttachedRef, "wolf" | "slug">,
	text: string,
	working: boolean,
	attachments: readonly { id: string }[] = [],
	fetchFn: typeof fetch = (...a) => fetch(...a),
): Promise<boolean> {
	const post = (whenBusy: "steer" | "reject") =>
		fetchFn(`${threadBase(ref.wolf, ref.slug)}/submit`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: text, whenBusy, ...(attachments.length ? { attachments: attachments.map((a) => ({ id: a.id })) } : {}) }),
		});
	try {
		let res = await post(whenBusyFor(working));
		if (res.status === 409 && !working) res = await post("steer");
		return res.ok;
	} catch {
		return false;
	}
}

/** The thread page's stop path: POST the abort route. */
export function abortThread(ref: Pick<AttachedRef, "wolf" | "slug">, fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<unknown> {
	return fetchFn(`${threadBase(ref.wolf, ref.slug)}/abort`, { method: "POST" }).catch(() => undefined);
}

/** Is the open page the attached thread's own page (where the page composer takes over and the bar hides)? */
export function onOwnThreadPage(pathname: string | null, ref: Pick<AttachedRef, "wolf" | "threadId"> | null): boolean {
	return !!ref && pathname === threadHref(ref.wolf, ref.threadId);
}

/** The thread a /wolf/<wolf>/thread/<slug> page shows (null on every other page). */
export function pageThreadOf(pathname: string | null): { wolf: string; slug: string } | null {
	const m = pathname?.match(/^\/wolf\/([^/]+)\/thread\/([^/]+)\/?$/);
	if (!m) return null;
	try {
		return { wolf: decodeURIComponent(m[1]!), slug: decodeURIComponent(m[2]!) };
	} catch {
		return null;
	}
}

/**
 * The ONE predicate for "the floating chat floats over another thread's page": the thread page this path shows, when a different thread is attached.
 * The swap pill (chat-bar.tsx) and the page composer stepping aside (thread-chat.tsx) both read it, so the composer never hides without a pill.
 */
export function swapTarget(pathname: string | null, attached: Pick<AttachedRef, "wolf" | "threadId"> | null): { wolf: string; slug: string } | null {
	const page = pageThreadOf(pathname);
	return page && attached && !onOwnThreadPage(pathname, attached) ? page : null;
}
