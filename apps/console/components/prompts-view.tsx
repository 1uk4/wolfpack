"use client";

/**
 * The Prompts page (/prompts): for the selected wolf, every registered prompt with its effective text and a default/overridden badge.
 * Editable prompts can be saved (sent with the etag the page loaded, so a concurrent edit is a visible 409 conflict) or reset to the
 * repo default. Overrides live in the wolf's home; other wolves keep the default.
 */
import { useCallback, useEffect, useState } from "react";

interface PromptRow {
	id: string;
	group: string;
	label: string;
	editable: boolean;
	text: string;
	source: "default" | "override";
	etag: string;
}

/** Truthful: wolfd builds the system prompt when it starts (and for reopened feature workspaces and new subagents), not per turn. */
export const APPLIES_NOTE =
	"An edit is saved at once but applies when the wolf restarts: wolfd builds its system prompt at start-up. Threads reopened in a feature workspace and new subagents pick it up earlier.";

async function readError(r: Response): Promise<string> {
	const body = (await r.json().catch(() => null)) as { error?: string; message?: string } | null;
	const msg = body?.error ?? body?.message ?? `request failed (${r.status})`;
	return r.status === 409 ? `Conflict: ${msg}. Reload to see the current text.` : r.status === 413 ? `Too large: ${msg}` : msg;
}

export function PromptsView() {
	const [wolves, setWolves] = useState<string[]>([]);
	const [wolf, setWolf] = useState("");
	const [rows, setRows] = useState<PromptRow[]>([]);
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [loadError, setLoadError] = useState("");

	useEffect(() => {
		void fetch("/api/wolves")
			.then((r) => r.json())
			.then((j: { wolves?: { name?: string; id?: string }[] } | { name?: string; id?: string }[]) => {
				const list = Array.isArray(j) ? j : (j.wolves ?? []);
				const names = list.map((w) => w.name ?? w.id ?? "").filter(Boolean);
				setWolves(names);
				setWolf((cur) => cur || names[0] || "");
			})
			.catch(() => setLoadError("Could not list wolves."));
	}, []);

	const load = useCallback(async () => {
		if (!wolf) return;
		setLoadError("");
		const r = await fetch(`/api/wolves/${encodeURIComponent(wolf)}/prompts`);
		if (!r.ok) return setLoadError(await readError(r));
		const j = (await r.json()) as { prompts: PromptRow[] };
		setRows(j.prompts);
		setDrafts({});
		setErrors({});
	}, [wolf]);
	useEffect(() => {
		void load();
	}, [load]);

	const send = async (row: PromptRow, method: "PUT" | "DELETE") => {
		const r = await fetch(`/api/wolves/${encodeURIComponent(wolf)}/prompts/${encodeURIComponent(row.id)}`, {
			method,
			headers: { "If-Match": row.etag, ...(method === "PUT" ? { "Content-Type": "application/json" } : {}) },
			...(method === "PUT" ? { body: JSON.stringify({ text: drafts[row.id] ?? row.text }) } : {}),
		});
		if (!r.ok) {
			const m = await readError(r);
			return setErrors((e) => ({ ...e, [row.id]: m }));
		}
		const next = (await r.json()) as PromptRow;
		setRows((rs) => rs.map((x) => (x.id === next.id ? next : x)));
		setDrafts((d) => {
			const { [row.id]: _gone, ...rest } = d;
			return rest;
		});
		setErrors((e) => ({ ...e, [row.id]: "" }));
	};

	return (
		<main className="mx-auto flex max-w-4xl flex-col gap-4 p-6" data-testid="prompts-page">
			<h1 className="text-lg font-semibold">Prompts</h1>
			<p className="text-sm text-muted-foreground" data-testid="prompts-applies-note">{APPLIES_NOTE}</p>
			<label className="flex items-center gap-2 text-sm">
				Wolf
				<select className="rounded border bg-background px-2 py-1" value={wolf} onChange={(e) => setWolf(e.target.value)} data-testid="prompts-wolf">
					{wolves.map((w) => (
						<option key={w} value={w}>{w}</option>
					))}
				</select>
			</label>
			{loadError && <p className="text-sm text-destructive" role="alert">{loadError}</p>}
			{rows.map((row) => {
				const draft = drafts[row.id] ?? row.text;
				return (
					<section key={row.id} className="flex flex-col gap-2 rounded-md border p-3" data-testid={`prompt-${row.id}`}>
						<header className="flex items-center gap-2">
							<span className="text-xs uppercase tracking-wider text-muted-foreground">{row.group}</span>
							<h2 className="text-sm font-medium">{row.label}</h2>
							<span className="rounded bg-accent px-1.5 py-0.5 text-xs" data-testid={`prompt-badge-${row.id}`}>{row.source === "override" ? "overridden" : "default"}</span>
							{!row.editable && <span className="text-xs text-muted-foreground">read-only</span>}
						</header>
						<textarea
							className="h-72 w-full rounded border bg-background p-2 font-mono text-xs"
							value={draft}
							readOnly={!row.editable}
							onChange={(e) => setDrafts((d) => ({ ...d, [row.id]: e.target.value }))}
							data-testid={`prompt-text-${row.id}`}
						/>
						{errors[row.id] && <p className="text-sm text-destructive" role="alert" data-testid={`prompt-error-${row.id}`}>{errors[row.id]}</p>}
						{row.editable && (
							<div className="flex gap-2">
								<button className="rounded border px-3 py-1 text-sm disabled:opacity-50" disabled={draft === row.text} onClick={() => void send(row, "PUT")} data-testid={`prompt-save-${row.id}`}>Save</button>
								<button className="rounded border px-3 py-1 text-sm disabled:opacity-50" disabled={row.source === "default"} onClick={() => void send(row, "DELETE")} data-testid={`prompt-reset-${row.id}`}>Reset to default</button>
								<button className="rounded border px-3 py-1 text-sm" onClick={() => void load()}>Reload</button>
							</div>
						)}
					</section>
				);
			})}
		</main>
	);
}
