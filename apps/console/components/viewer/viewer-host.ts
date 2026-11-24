import { viewerKey } from "./viewer-store";

/**
 * Where a viewer is mounted. One set of components, two kinds of host: the thread page (today's behaviour) and a
 * "page viewer" on a non-thread page that wolves cannot reach. `id` is the storage scope.
 */
export interface ViewerHost {
	/** `thread:<wolf>:<threadId>` or `page:<scope>`. */
	id: string;
	/** Kinds this host may open; a trigger for any other kind is not handled and falls back to its normal navigation. */
	allowedKinds: readonly string[] | "all";
	/** Mirror the top of the stack in `?view=`. */
	urlSync: boolean;
	/** Show the pin button in the header. */
	pins: boolean;
	/** Mount the show_view arrivals (thread-chat only; wolves write these). */
	viewObjects: boolean;
}

export const threadHost = (wolf: string, threadId: string): ViewerHost => ({
	id: `thread:${wolf}:${threadId}`,
	allowedKinds: "all",
	urlSync: true,
	pins: true,
	viewObjects: true,
});

export const pageHost = (scope: string, allowedKinds: readonly string[] | "all"): ViewerHost => ({
	id: `page:${scope}`,
	allowedKinds,
	urlSync: true,
	pins: false,
	viewObjects: false,
});

/** The (wolf, threadId) pair the per-thread store is keyed by: a thread host maps to itself, a page host to ("page", scope). */
export function hostStoreArgs(host: ViewerHost): [string, string] {
	if (host.id.startsWith("thread:")) {
		const rest = host.id.slice("thread:".length);
		const i = rest.indexOf(":");
		return [rest.slice(0, i), rest.slice(i + 1)];
	}
	return ["page", host.id.slice("page:".length)];
}

export const hostStoreKey = (host: ViewerHost): string => viewerKey(...hostStoreArgs(host));

export const hostAllows = (host: Pick<ViewerHost, "allowedKinds">, kind: string): boolean => host.allowedKinds === "all" || host.allowedKinds.includes(kind);
