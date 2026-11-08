"use client";

/**
 * New feature: pick a wolf, optionally write a one-line idea, start. The wolf itself resolves its new-work prompt (its own overrides)
 * and sends it into its home thread (POST /api/wolves/:name/new-feature); this page only opens that thread. Local and remote wolves
 * behave the same: the proxy carries the browser's device token and the hub relays to the wolf's host.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface WolfRow { name: string; host?: string }

export function NewFeatureView() {
	const router = useRouter();
	const [wolves, setWolves] = useState<WolfRow[]>([]);
	const [wolf, setWolf] = useState("");
	const [idea, setIdea] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		void fetch("/api/wolves")
			.then((r) => r.json())
			.then((j: { wolves?: WolfRow[] } | WolfRow[]) => {
				const list = (Array.isArray(j) ? j : (j.wolves ?? [])).filter((w) => w.name);
				setWolves(list);
				setWolf((cur) => cur || list[0]?.name || "");
			})
			.catch(() => setError("Could not list wolves."));
	}, []);

	const start = async () => {
		if (!wolf || busy) return;
		setBusy(true);
		setError("");
		try {
			const r = await fetch(`/api/wolves/${encodeURIComponent(wolf)}/new-feature`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(idea.trim() ? { idea: idea.trim() } : {}),
			});
			const j = (await r.json().catch(() => ({}))) as { threadId?: string; error?: string; code?: string };
			if (!r.ok || !j.threadId) {
				setError(j.code === "busy" ? `${wolf} is mid-turn in its home thread; wait for it to finish, then try again.` : (j.error ?? "Could not start."));
				setBusy(false);
				return;
			}
			// Same URL shape as the sidebar's thread rows: /wolf/<wolf>/thread/<id without the wolf prefix>.
			const slug = j.threadId.startsWith(`${wolf}/`) ? j.threadId.slice(wolf.length + 1) : j.threadId;
			router.push(`/wolf/${encodeURIComponent(wolf)}/thread/${encodeURIComponent(slug)}`);
		} catch {
			setError("Could not reach the console.");
			setBusy(false);
		}
	};

	return (
		<div className="mx-auto flex w-full max-w-xl flex-col gap-4 p-8" data-testid="new-feature">
			<h1 className="font-serif text-2xl">New feature</h1>
			<p className="text-sm text-muted-foreground">
				Starts the grilling, spec and tickets flow in the wolf&apos;s home thread, using that wolf&apos;s own prompts.
			</p>
			<label className="flex flex-col gap-1 text-xs uppercase tracking-wider text-muted-foreground">
				Wolf
				<select data-testid="new-feature-wolf" className="rounded-md border bg-card px-2 py-1.5 text-sm normal-case text-foreground" value={wolf} onChange={(e) => setWolf(e.target.value)}>
					{wolves.map((w) => <option key={w.name} value={w.name}>{w.name}{w.host ? ` (${w.host})` : ""}</option>)}
				</select>
			</label>
			<label className="flex flex-col gap-1 text-xs uppercase tracking-wider text-muted-foreground">
				Idea (optional)
				<input
					data-testid="new-feature-idea"
					className="rounded-md border bg-card px-2 py-1.5 text-sm normal-case text-foreground"
					value={idea}
					maxLength={2000}
					onChange={(e) => setIdea(e.target.value)}
					onKeyDown={(e) => { if (e.key === "Enter") void start(); }}
					placeholder="One line on what you want"
				/>
			</label>
			{error && <p role="alert" className="text-sm text-destructive" data-testid="new-feature-error">{error}</p>}
			<button type="button" data-testid="new-feature-start" disabled={!wolf || busy} onClick={() => void start()} className="self-start rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50">
				{busy ? "Starting…" : "Start"}
			</button>
		</div>
	);
}
