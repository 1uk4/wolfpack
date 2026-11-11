"use client";

import { useEffect } from "react";
import { HUB_COOKIE, HUB_COOKIE_HOST, readHubToken } from "@/src/core/ui/hub-auth";

/**
 * Route error boundary. A server-rendered page that failed because the hub rejected the browser's token cannot tell the browser why (Next
 * redacts the message in production), so probe once: the hub-auth fetch wrapper (components/hub-auth.tsx) clears the stored token + cookie
 * and goes to /pair on a hub-auth 401, and otherwise this just shows the retry.
 */
export default function RouteError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
	useEffect(() => {
		// Nothing to be rejected (no stored token, no cookie): not an auth failure, skip the probe.
		const hasCookie = document.cookie.split(";").some((c) => [HUB_COOKIE, HUB_COOKIE_HOST].includes(c.split("=")[0]!.trim()));
		if (!readHubToken(window.localStorage) && !hasCookie) return;
		void fetch("/api/wolves").catch(() => {});
	}, []);
	return (
		<main className="mx-auto max-w-md p-8">
			<h1 className="text-lg">Something went wrong</h1>
			<button type="button" className="mt-4 underline" onClick={reset}>
				Try again
			</button>
		</main>
	);
}
