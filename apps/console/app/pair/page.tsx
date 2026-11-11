"use client";

/**
 * Console sign-in: the hub's /pair page sends the browser here as `/pair#token=...` after a successful pairing. We store the token in
 * localStorage, strip the fragment from the address bar and go home. Opened without a token (first visit, after a 401, or the installed
 * PWA where no URL can be typed) it shows one box that takes a raw token or a full pairing link, and a smaller link to the hub's
 * pairing page (the URL comes from /api/hub-url, set at runtime by HUBD_PUBLIC_URL). The pasted text is never logged or echoed.
 */
import { useEffect, useRef, useState } from "react";
import { saveHubToken, tokenFromHash, tokenFromPairingInput } from "@/src/core/hub-auth";

export default function PairPage() {
	const [stored, setStored] = useState<boolean | undefined>();
	const [HUB_URL, setHubUrl] = useState<string | undefined>();
	const [error, setError] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
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
	const submit = (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		const value = inputRef.current?.value ?? "";
		const token = tokenFromPairingInput(value);
		if (!token) {
			setError(true);
			return;
		}
		saveHubToken(window.localStorage, token);
		window.location.replace("/");
	};
	return (
		<main className="mx-auto max-w-md p-8">
			<h1 className="text-lg">{stored ? "Paired" : "Sign in to the hub"}</h1>
			{stored ? (
				<p>Token saved. Opening the console...</p>
			) : (
				<>
					<form onSubmit={submit} className="mt-4 flex flex-col gap-3">
						<label htmlFor="pairing" className="text-sm">Pairing token or link</label>
						<input
							id="pairing"
							ref={inputRef}
							name="pairing"
							type="password"
							autoComplete="off"
							autoCapitalize="none"
							autoCorrect="off"
							spellCheck={false}
							onChange={() => setError(false)}
							className="min-h-11 w-full rounded-lg border bg-background px-3 text-base"
						/>
						{error && <p role="alert" className="text-sm text-destructive">That doesn't look like a pairing token or link.</p>}
						<button type="submit" className="min-h-11 rounded-lg border px-4 text-sm hover:bg-accent hover:text-accent-foreground">Sign in</button>
					</form>
					<p className="mt-6 text-xs text-muted-foreground">
						Or run <code>hubd pair --kind browser --url &lt;hub url&gt;</code> and{" "}
						{HUB_URL ? <a className="underline" href={`${HUB_URL}/pair`}>open the hub pairing page</a> : "open the hub's /pair page"}.
					</p>
				</>
			)}
		</main>
	);
}
