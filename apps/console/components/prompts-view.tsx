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
	kind?: "editable" | "system-block" | "tool" | "pipeline" | "compaction";
	file?: string;
	user?: string;
	scope?: "wolf" | "global" | "hub";
	contract?: string;
	/** Editable rows: when an edit takes effect (from wolfd). */
	applies?: string;
	/** Profiles and standards: a project `.pi` file in the wolf's workspace outranks the wolf's edit. */
	projectOverride?: boolean;
	/** Identity only: wolf.yaml `identity:` points at this other file, so the running wolf ignores agent/AGENTS.md. */
	inlineIdentity?: string;
}

/** wolf.yaml `prompts.structuredOutput` as the settings view reports it. */
interface SettingsInfo {
	etag: string;
	/** undefined: the default guidance is in effect. */
	value: string | false | undefined;
	restartNeeded: boolean;
}

const STRUCTURED = "system.structured-output";

/** Groups read at every subagent spawn, not at wolf start-up: the global restart note does not apply to them. */
const SPAWN_GROUPS = new Set(["Helper profiles", "Standards"]);

const HUB = "__hub__";
/** Past this many characters a read-only text starts collapsed. */
const COLLAPSE_AT = 400;

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
	const [group, setGroup] = useState("");
	const [open, setOpen] = useState<Record<string, boolean>>({});
	const [settings, setSettings] = useState<SettingsInfo | null>(null);
	const [soDraft, setSoDraft] = useState<string | null>(null);

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
		setGroup("");
		if (wolf === HUB) {
			const o = await fetch("/api/settings/overview");
			if (!o.ok) return setLoadError(await readError(o));
			const j = (await o.json()) as { hub?: { ok: boolean; error?: string; settings?: { prompts: { id: string; group: string; label: string; text: string }[] } } };
			if (!j.hub?.ok) return setLoadError(`The hub did not answer: ${j.hub?.error ?? "unknown error"}`);
			setRows(
				(j.hub.settings?.prompts ?? []).map((p) => ({
					...p,
					editable: false,
					source: "default" as const,
					etag: "",
					kind: "pipeline" as const,
					file: "packages/engine/src/prompts.ts (hubd GET /v1/settings)",
					user: "hubd KB sweep (librarian)",
					scope: "hub" as const,
				})),
			);
			setDrafts({});
			setErrors({});
			return;
		}
		const r = await fetch(`/api/wolves/${encodeURIComponent(wolf)}/prompts`);
		if (!r.ok) return setLoadError(await readError(r));
		const j = (await r.json()) as { prompts: PromptRow[] };
		setRows(j.prompts);
		setDrafts({});
		setErrors({});
		setSoDraft(null);
		setSettings(null);
		const sr = await fetch(`/api/wolves/${encodeURIComponent(wolf)}/settings`).catch(() => null);
		if (sr?.ok) {
			const v = (await sr.json()) as { etag: string; config?: { prompts?: { structuredOutput?: string | false } }; restartNeeded?: boolean };
			setSettings({ etag: v.etag, value: v.config?.prompts?.structuredOutput, restartNeeded: !!v.restartNeeded });
		}
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

	/** Save wolf.yaml prompts.structuredOutput through the settings PUT (not a prompt override file): a string, false (no guidance) or null (the default). */
	const saveStructured = async (value: string | false | null) => {
		if (!settings) return;
		const r = await fetch(`/api/wolves/${encodeURIComponent(wolf)}/settings`, {
			method: "PUT",
			headers: { "If-Match": settings.etag, "Content-Type": "application/json" },
			body: JSON.stringify({ set: { "prompts.structuredOutput": value } }),
		});
		if (!r.ok) {
			const m = await readError(r);
			return setErrors((e) => ({ ...e, [STRUCTURED]: m }));
		}
		await load();
	};

	const groups = [...new Set(rows.map((r) => r.group))];
	const shown = group ? rows.filter((r) => r.group === group) : rows;

	return (
		<main className="mx-auto flex max-w-4xl flex-col gap-4 p-6" data-testid="prompts-page">
			<h1 className="text-lg font-semibold">Prompts</h1>
			{!SPAWN_GROUPS.has(group) && <p className="text-sm text-muted-foreground" data-testid="prompts-applies-note">{APPLIES_NOTE}</p>}
			<label className="flex items-center gap-2 text-sm">
				Wolf
				<select className="rounded border bg-background px-2 py-1" value={wolf} onChange={(e) => setWolf(e.target.value)} data-testid="prompts-wolf">
					{wolves.map((w) => (
						<option key={w} value={w}>{w}</option>
					))}
					<option value={HUB}>Hub (KB sweep prompts)</option>
				</select>
			</label>
			{groups.length > 1 && (
				<nav className="flex flex-wrap gap-1.5" aria-label="Prompt groups" data-testid="prompts-groups">
					{["", ...groups].map((g) => (
						<button key={g || "all"} className={`rounded border px-2 py-0.5 text-xs ${group === g ? "bg-accent" : ""}`} onClick={() => setGroup(g)} data-testid={`prompts-group-${g || "all"}`}>
							{g || "All"} ({g ? rows.filter((r) => r.group === g).length : rows.length})
						</button>
					))}
				</nav>
			)}
			{loadError && <p className="text-sm text-destructive" role="alert">{loadError}</p>}
			{shown.map((row) => {
				const draft = drafts[row.id] ?? row.text;
				return (
					<section key={row.id} className="flex flex-col gap-2 rounded-md border p-3" data-testid={`prompt-${row.id}`}>
						<header className="flex items-center gap-2">
							<span className="text-xs uppercase tracking-wider text-muted-foreground">{row.group}</span>
							<h2 className="text-sm font-medium">{row.label}</h2>
							<span className="rounded bg-accent px-1.5 py-0.5 text-xs" data-testid={`prompt-badge-${row.id}`}>{row.source === "override" ? "overridden" : "default"}</span>
							{!row.editable && <span className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground" data-testid={`prompt-readonly-${row.id}`}>read-only</span>}
						</header>
						{(row.file || row.user || row.scope) && (
							<dl className="grid grid-cols-[auto_1fr] gap-x-3 text-xs text-muted-foreground" data-testid={`prompt-meta-${row.id}`}>
								{row.file && (<><dt>Source</dt><dd className="break-all font-mono">{row.file}</dd></>)}
								{row.user && (<><dt>Used by</dt><dd>{row.user}</dd></>)}
								{row.scope && (<><dt>Scope</dt><dd>{row.scope === "wolf" ? "per wolf" : row.scope}</dd></>)}
							</dl>
						)}
						{row.editable && row.applies && <p className="text-xs text-muted-foreground" data-testid={`prompt-applies-${row.id}`}>An edit applies {row.applies}. The previous version is kept as a backup (last 10).{row.id === "identity" ? " This is the wolf's own agent/AGENTS.md; Reset restores the newest backup (there is no repo default)." : ""}</p>}
						{row.editable && row.inlineIdentity && (
							<p className="text-xs text-destructive" data-testid={`prompt-inline-identity-${row.id}`}>wolf.yaml sets <span className="font-mono">identity: {row.inlineIdentity}</span>, which the running wolf reads instead of this file. An edit here is saved but has no effect until that line is removed.</p>
						)}
						{row.id === STRUCTURED && (
							<div className="flex flex-col gap-2" data-testid="structured-output-edit">
								<p className="text-xs text-muted-foreground" data-testid="structured-output-state">
									Applies when the wolf restarts. In wolf.yaml now:{" "}
									{!settings ? "unknown (settings not available)" : settings.value === undefined ? "nothing, so the default guidance is used" : settings.value === false ? "false, so the guidance is removed" : "a custom text"}
									{settings?.restartNeeded ? " (restart needed)" : ""}. Saved to wolf.yaml prompts.structuredOutput, not to a prompt file.
								</p>
								{settings && (
									<>
										<textarea className="h-40 w-full rounded border bg-background p-2 font-mono text-xs" value={soDraft ?? (typeof settings.value === "string" ? settings.value : row.text.replace(/^# Structured output\n\n/, ""))} onChange={(e) => setSoDraft(e.target.value)} data-testid="structured-output-text" />
										<div className="flex gap-2">
											<button className="rounded border px-3 py-1 text-sm disabled:opacity-50" disabled={soDraft === null} onClick={() => void saveStructured(soDraft ?? "")} data-testid="structured-output-save">Save custom text</button>
											<button className="rounded border px-3 py-1 text-sm" onClick={() => void saveStructured(false)} data-testid="structured-output-remove">Remove the guidance</button>
											<button className="rounded border px-3 py-1 text-sm disabled:opacity-50" disabled={settings.value === undefined} onClick={() => void saveStructured(null)} data-testid="structured-output-default">Use the default</button>
										</div>
									</>
								)}
							</div>
						)}
						{row.editable && row.projectOverride && (
							<p className="text-xs text-destructive" data-testid={`prompt-project-override-${row.id}`}>This workspace has its own .pi file for it, which wins over an edit made here.</p>
						)}
						{!row.editable ? (
							<>
								<pre
									className={`w-full overflow-auto whitespace-pre-wrap rounded border bg-muted/30 p-2 font-mono text-xs ${open[row.id] || row.text.length <= COLLAPSE_AT ? "max-h-[32rem]" : "max-h-20"}`}
									data-testid={`prompt-text-${row.id}`}
								>{row.text}</pre>
								{row.text.length > COLLAPSE_AT && (
									<button className="self-start text-xs underline" onClick={() => setOpen((o) => ({ ...o, [row.id]: !o[row.id] }))} data-testid={`prompt-expand-${row.id}`}>
										{open[row.id] ? "Collapse" : `Show full text (${row.text.length} characters)`}
									</button>
								)}
								{row.contract && (
									<details data-testid={`prompt-contract-${row.id}`}>
										<summary className="cursor-pointer text-xs">Output contract (read-only: the reply is parsed against this)</summary>
										<pre className="mt-1 max-h-72 overflow-auto rounded border bg-muted/30 p-2 font-mono text-xs">{row.contract}</pre>
									</details>
								)}
							</>
						) : (
						<textarea
							className="h-72 w-full rounded border bg-background p-2 font-mono text-xs"
							value={draft}
							readOnly={!row.editable}
							onChange={(e) => setDrafts((d) => ({ ...d, [row.id]: e.target.value }))}
							data-testid={`prompt-text-${row.id}`}
						/>
						)}
						{errors[row.id] && <p className="text-sm text-destructive" role="alert" data-testid={`prompt-error-${row.id}`}>{errors[row.id]}</p>}
						{row.editable && (
							<div className="flex gap-2">
								<button className="rounded border px-3 py-1 text-sm disabled:opacity-50" disabled={draft === row.text} onClick={() => void send(row, "PUT")} data-testid={`prompt-save-${row.id}`}>Save</button>
								<button className="rounded border px-3 py-1 text-sm disabled:opacity-50" disabled={row.id === "identity" ? false : row.source === "default"} onClick={() => void send(row, "DELETE")} data-testid={`prompt-reset-${row.id}`}>{row.id === "identity" ? "Restore previous version" : "Reset to default"}</button>
								<button className="rounded border px-3 py-1 text-sm" onClick={() => void load()}>Reload</button>
							</div>
						)}
					</section>
				);
			})}
		</main>
	);
}
