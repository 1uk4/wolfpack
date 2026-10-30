"use client";

/**
 * Installs the hub sign-in fetch wrapper (src/core/hub-auth.ts) on `window.fetch` at MODULE LOAD, not in an effect: children's effects
 * run before a parent's, so an effect would let the first /api requests go out without the token. Idempotent (HMR-safe).
 */
import { HUB_TOKEN_KEY, PAIR_PATH, withHubAuth } from "@/src/core/hub-auth";

const MARK = Symbol.for("wolfpack.console.hub-auth");

function install(): void {
	const w = window as unknown as { [MARK]?: true };
	if (w[MARK]) return;
	w[MARK] = true;
	window.fetch = withHubAuth(window.fetch.bind(window), {
		storage: window.localStorage,
		origin: window.location.origin,
		onUnauthorized: () => {
			if (!window.location.pathname.startsWith(PAIR_PATH)) window.location.assign(PAIR_PATH);
		},
	});
}
if (typeof window !== "undefined") install();

export { HUB_TOKEN_KEY };
export default function HubAuth(): null {
	return null;
}
