/**
 * Clicking a wolf's body is the owner's handle for talking to it: point the floating chat at the wolf's home thread and focus it;
 * with no floating chat available, open the home thread's page instead.
 */
import { threadHref, type BarThread } from "@/src/core";

export interface TalkDeps {
	/** Threads by wolf, from the attached-thread provider; absent outside it. */
	threads?: Record<string, readonly BarThread[] | undefined>;
	attach?: (ref: { wolf: string; threadId: string }) => void;
	focusComposer: () => void;
	navigate: (href: string) => void;
}

/** The wolf's home thread id, if the thread lists know it. */
export function homeThreadId(threads: TalkDeps["threads"], wolf: string): string | undefined {
	return threads?.[wolf]?.find((t) => t.kind === "home" && !t.closed)?.id;
}

/** Returns what it did. */
export function talkToWolf(wolf: string, d: TalkDeps): "composer" | "page" | "none" {
	const id = homeThreadId(d.threads, wolf);
	if (!id) return "none";
	if (d.attach) {
		d.attach({ wolf, threadId: id });
		setTimeout(d.focusComposer, 0); // the bar re-targets on the next render: focus after it
		return "composer";
	}
	d.navigate(threadHref(wolf, id));
	return "page";
}
