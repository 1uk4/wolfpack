"use client";

/**
 * Console sign-in: the hub's /pair page sends the browser here as `/pair#token=...` after a successful pairing. We store the token in
 * localStorage, strip the fragment from the address bar and go home. Opened without a token (first visit, or after a 401) it points
 * the user at the hub's pairing page (the URL comes from /api/hub-url, set at runtime by HUBD_PUBLIC_URL).
 */
import { useEffect, useState } from "react";
import { saveHubToken, tokenFromHash } from "@/src/core/hub-auth";

export default function PairPage() {
	const [stored, setStored] = useState<boolean | undefined>();
	const [HUB_URL, setHubUrl] = useState<string | undefined>();
	useEffect(() => {
		const token = tokenFromHash(window.location.hash);
		history.replaceState(null, "", window.location.pathname);
		if (!token) {
			setStored(false);
			void fetch("/api/hub-url").then((r) => r.json()).then((j: { url?: string | null }) => setHubUrl(j.url || undefined)).catch(() => {});
			return;
		}
		saveHubToken(window.localStorage, token);
		setStored(true);
		window.location.replace("/");
	}, []);
	if (stored === undefined) return null;
	return (
		<main className="mx-auto max-w-md p-8">
			<h1 className="text-lg">{stored ? "Paired" : "Sign in to the hub"}</h1>
			{stored ? (
				<p>Token saved. Opening the console...</p>
			) : (
				<p>
					This console has no hub token (or the hub rejected it). Run <code>hubd pair --kind browser --url &lt;hub url&gt;</code> and{" "}
					{HUB_URL ? <a className="underline" href={`${HUB_URL}/pair`}>open the hub pairing page</a> : "open the hub's /pair page"}.
				</p>
			)}
		</main>
	);
}
