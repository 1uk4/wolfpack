"use client";

import { useEffect } from "react";

/**
 * Route error boundary. A server-rendered page that failed because the hub rejected the browser's token cannot tell the browser why (Next
 * redacts the message in production), so probe once: the hub-auth fetch wrapper (components/hub-auth.tsx) clears the stored token + cookie
 * and goes to /pair on a hub-auth 401, and otherwise this just shows the retry.
 */
export default function RouteError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
	useEffect(() => {
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
