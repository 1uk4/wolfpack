"use client";

/**
 * The wolf Settings page (/settings): for the selected wolf, the whole wolf.yaml (secrets masked, Reveal behind a confirm), edit
 * forms for the keys wolfd allows (rendered from `editable[]`), the environment variable names, and a Restart button with the
 * "restart needed" / "restart pending" banner. Local and remote (sfo-01 through the hub relay) wolves behave the same: every call
 * goes through /api/wolves/:name/settings*, which carries the browser's device token.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { buildPayload, fieldKind, getAt, parseIssues, retryAfterSeconds, type Draft } from "@/src/core";

interface EnvVar { name: string; set: boolean; secret: boolean; purpose: string }
interface SettingsView {
	etag: string;
	config: Record<string, unknown>;
	editable: string[];
	tierModels: Record<string, string>;
	env: EnvVar[];
	restartNeeded: boolean;
	restartable: boolean;
	restartAvailableInSeconds: number;
}
interface WolfRow { name: string; host?: string }

const SECTIONS: { id: string; title: string; match: (k: string) => boolean }[] = [
	{ id: "models", title: "Models and tiers", match: (k) => k.startsWith("models.") || k.startsWith("tiers.") },
	{ id: "subagents", title: "Subagents", match: (k) => k.startsWith("subagents.") },
	{ id: "compaction", title: "Compaction", match: (k) => k.startsWith("compaction.") },
	{ id: "memory", title: "Memory", match: (k) => k.startsWith("memory.") },
];

async function readError(r: Response): Promise<{ message: string; code?: string; details?: Record<string, unknown> }> {
	const b = (await r.json().catch(() => null)) as { error?: string; message?: string; code?: string; details?: Record<string, unknown> } | null;
	return { message: b?.error ?? b?.message ?? `request failed (${r.status})`, code: b?.code, details: b?.details };
}

const isMasked = (v: unknown): v is { set: boolean } =>
	!!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && typeof (v as { set?: unknown }).set === "boolean";

export function WolfSettingsView() {
	const [wolves, setWolves] = useState<WolfRow[]>([]);
	const [wolf, setWolf] = useState("");
	const [view, setView] = useState<SettingsView | null>(null);
	const [drafts, setDrafts] = useState<Record<string, Draft>>({});
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [formError, setFormError] = useState("");
	const [loadError, setLoadError] = useState("");
	const [revealed, setRevealed] = useState<Record<string, string>>({});
	const [confirming, setConfirming] = useState("");
	const [pending, setPending] = useState(false);
	const [restartError, setRestartError] = useState("");
	const [wait, setWait] = useState(0);
	const [saved, setSaved] = useState(false);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	useEffect(() => {
		void fetch("/api/wolves")
			.then((r) => r.json())
			.then((j: { wolves?: WolfRow[] } | WolfRow[]) => {
				const list = (Array.isArray(j) ? j : (j.wolves ?? [])).filter((w) => w.name);
				setWolves(list);
				setWolf((cur) => cur || list[0]?.name || "");
			})
			.catch(() => setLoadError("Could not list wolves."));
	}, []);

	const base = `/api/wolves/${encodeURIComponent(wolf)}/settings`;

	const load = useCallback(async () => {
		if (!wolf) return;
		setLoadError("");
		const r = await fetch(`/api/wolves/${encodeURIComponent(wolf)}/settings`);
		if (!r.ok) {
			setView(null);
			return setLoadError((await readError(r)).message);
		}
		const v = (await r.json()) as SettingsView;
		setView(v);
		setWait(v.restartAvailableInSeconds);
		setDrafts({});
		setErrors({});
		setFormError("");
		setRevealed({});
		setConfirming("");
	}, [wolf]);

	useEffect(() => {
		setPending(false);
		setRestartError("");
		setSaved(false);
		if (pollRef.current) clearInterval(pollRef.current);
		void load();
	}, [load]);
	useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

	// Countdown to the earliest allowed restart.
	useEffect(() => {
		if (wait <= 0) return;
		const t = setTimeout(() => setWait((w) => Math.max(0, w - 1)), 1000);
		return () => clearTimeout(t);
	}, [wait]);

	const save = async () => {
		if (!view) return;
		const { set, invalid } = buildPayload(view.config, drafts);
		setErrors(invalid);
		setFormError("");
		setSaved(false);
		if (Object.keys(invalid).length || !Object.keys(set).length) return;
		const r = await fetch(base, { method: "PUT", headers: { "Content-Type": "application/json", "If-Match": view.etag }, body: JSON.stringify({ set }) });
		if (!r.ok) {
			const e = await readError(r);
			if (r.status === 409) return setFormError("This wolf's config changed since you loaded it. Reload to see the current values.");
			if (r.status === 400) {
				const issues = parseIssues(e.message);
				const known = Object.fromEntries(Object.entries(issues).filter(([k]) => view.editable.includes(k)));
				setErrors(known);
				return setFormError(Object.keys(known).length ? "" : e.message);
			}
			return setFormError(e.message);
		}
		const v = (await r.json()) as SettingsView;
		setView(v);
		setDrafts({});
		setSaved(true);
	};

	const reveal = async (source: "env" | "config", name: string) => {
		const r = await fetch(`${base}/reveal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source, name }) });
		setConfirming("");
		if (!r.ok) {
			const e = await readError(r);
			return setRevealed((m) => ({ ...m, [`${source}:${name}`]: `(${e.message})` }));
		}
		const j = (await r.json()) as { value: string | null };
		setRevealed((m) => ({ ...m, [`${source}:${name}`]: j.value ?? "(not set)" }));
	};

	const restart = async () => {
		setRestartError("");
		const r = await fetch(`${base}/restart`, { method: "POST" });
		if (!r.ok) {
			const e = await readError(r);
			if (r.status === 429) {
				const s = retryAfterSeconds(e.details);
				setWait(s);
				return setRestartError(`The wolf started less than a minute ago. Restart is available in ${s || "a few"}s.`);
			}
			return setRestartError(r.status === 409 ? "This wolf is not supervised, so it cannot restart itself." : e.message);
		}
		setPending(true);
		const started = Date.now();
		let seenDown = false;
		if (pollRef.current) clearInterval(pollRef.current);
		pollRef.current = setInterval(() => {
			void fetch(base)
				.then(async (res) => {
					if (!res.ok) return void (seenDown = true);
					if (!seenDown && Date.now() - started < 8000) return;
					if (pollRef.current) clearInterval(pollRef.current);
					setPending(false);
					const v = (await res.json()) as SettingsView;
					setView(v);
					setWait(v.restartAvailableInSeconds);
					setDrafts({});
					setRevealed({});
				})
				.catch(() => void (seenDown = true));
		}, 2000);
	};

	const renderField = (key: string) => {
		if (!view) return null;
		const k = fieldKind(key);
		const current = getAt(view.config, key);
		const draft = drafts[key];
		const dirty = key in drafts;
		const set = (d: Draft) => setDrafts((m) => ({ ...m, [key]: d }));
		const cleared = draft === null;
		const text = typeof draft === "string" ? draft : current === undefined || current === null ? "" : String(current);
		const common = { "aria-label": key, "data-testid": `field-${key}`, disabled: cleared, className: "rounded border bg-background px-2 py-1 text-sm disabled:opacity-50" };
		return (
			<div key={key} className="flex flex-col gap-1" data-testid={`row-${key}`}>
				<div className="flex flex-wrap items-center gap-2">
					<label className="w-72 shrink-0 font-mono text-xs text-muted-foreground" htmlFor={`f-${key}`}>{key}</label>
					{k.kind === "boolean" ? (
						<input id={`f-${key}`} type="checkbox" {...common} className="size-4" checked={typeof draft === "boolean" ? draft : current === true} onChange={(e) => set(e.target.checked)} />
					) : k.kind === "enum" ? (
						<select id={`f-${key}`} {...common} value={text} onChange={(e) => set(e.target.value)}>
							<option value="">(unset)</option>
							{[...new Set([...k.options, ...(text && !k.options.includes(text) ? [text] : [])])].map((o) => <option key={o} value={o}>{o}</option>)}
						</select>
					) : k.kind === "textarea" ? (
						<textarea id={`f-${key}`} {...common} className="h-40 w-full rounded border bg-background p-2 font-mono text-xs disabled:opacity-50" value={text} onChange={(e) => set(e.target.value)} />
					) : (
						<input id={`f-${key}`} type={k.kind === "number" ? "number" : "text"} {...common} value={text} onChange={(e) => set(e.target.value)} />
					)}
					{current !== undefined && (
						<button type="button" className="text-xs underline" data-testid={`clear-${key}`} onClick={() => set(cleared ? (current === undefined ? "" : String(current)) : null)}>
							{cleared ? "undo clear" : "clear"}
						</button>
					)}
					{dirty && <span className="text-xs text-muted-foreground">{cleared ? "will be removed" : "edited"}</span>}
				</div>
				{errors[key] && <p className="pl-72 text-xs text-destructive" role="alert" data-testid={`error-${key}`}>{errors[key]}</p>}
			</div>
		);
	};

	const renderConfig = (value: unknown, path: string, depth: number): React.ReactNode => {
		if (isMasked(value)) {
			const id = `config:${path}`;
			return (
				<span className="inline-flex items-center gap-2" data-testid={`cfg-${path}`}>
					<span>{revealed[id] ?? (value.set ? "set" : "not set")}</span>
					{value.set && revealed[id] === undefined && (confirming === id ? (
						<>
							<button className="text-xs underline" data-testid={`reveal-confirm-${path}`} onClick={() => void reveal("config", path)}>Show the value</button>
							<button className="text-xs underline" onClick={() => setConfirming("")}>Cancel</button>
						</>
					) : (
						<button className="text-xs underline" data-testid={`reveal-${path}`} onClick={() => setConfirming(id)}>Reveal</button>
					))}
				</span>
			);
		}
		if (value && typeof value === "object") {
			const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
			return (
				<ul className="flex flex-col gap-0.5" style={{ paddingLeft: depth ? 16 : 0 }}>
					{entries.map(([k, v]) => (
						<li key={k} className="font-mono text-xs">
							<span className="text-muted-foreground">{k}:</span> {renderConfig(v, path ? `${path}.${k}` : k, depth + 1)}
						</li>
					))}
				</ul>
			);
		}
		return <span>{value === null ? "null" : JSON.stringify(value)}</span>;
	};

	const host = wolves.find((w) => w.name === wolf)?.host;
	const editable = view?.editable ?? [];
	const other = editable.filter((k) => !SECTIONS.some((s) => s.match(k)));
	const dirtyCount = Object.keys(drafts).length;
	const canRestart = !!view && view.restartable && wait <= 0 && !pending;

	return (
		<main className="mx-auto flex max-w-4xl flex-col gap-4 p-6" data-testid="wolf-settings-page">
			<h1 className="text-lg font-semibold">Settings</h1>
			<label className="flex items-center gap-2 text-sm">
				Wolf
				<select className="rounded border bg-background px-2 py-1" value={wolf} onChange={(e) => setWolf(e.target.value)} data-testid="settings-wolf">
					{wolves.map((w) => <option key={w.name} value={w.name}>{w.name}{w.host ? ` (${w.host})` : ""}</option>)}
				</select>
				{host && <span className="text-xs text-muted-foreground" data-testid="settings-host">host: {host}</span>}
			</label>
			{loadError && <p className="text-sm text-destructive" role="alert" data-testid="settings-load-error">{loadError}</p>}
			{view && (
				<>
					{pending ? (
						<p className="rounded border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm" role="status" data-testid="banner-restart-pending">Restart pending: waiting for {wolf} to answer again…</p>
					) : view.restartNeeded ? (
						<p className="rounded border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm" role="status" data-testid="banner-restart-needed">Restart needed: wolf.yaml changed since {wolf} started, so the running wolf still has the old values.</p>
					) : null}
					<div className="flex flex-wrap items-center gap-3">
						<button className="rounded border px-3 py-1 text-sm disabled:opacity-50" disabled={!canRestart} onClick={() => void restart()} data-testid="restart-button">Restart {wolf}</button>
						{!view.restartable && <span className="text-xs text-muted-foreground" data-testid="restart-reason">Not supervised: this wolf cannot restart itself.</span>}
						{view.restartable && wait > 0 && <span className="text-xs text-muted-foreground" data-testid="restart-countdown">Available in {wait}s</span>}
						{restartError && <span className="text-xs text-destructive" role="alert" data-testid="restart-error">{restartError}</span>}
						<button className="rounded border px-3 py-1 text-sm" onClick={() => void load()} data-testid="settings-reload">Reload</button>
					</div>

					{SECTIONS.map((s) => {
						const keys = editable.filter(s.match);
						if (!keys.length && s.id !== "models") return null;
						return (
							<section key={s.id} className="flex flex-col gap-2 rounded-md border p-3" data-testid={`section-${s.id}`}>
								<h2 className="text-sm font-medium">{s.title}</h2>
								{s.id === "models" && Object.keys(view.tierModels).length > 0 && (
									<p className="text-xs text-muted-foreground" data-testid="tier-models">Running now: {Object.entries(view.tierModels).map(([t, m]) => `${t} = ${m}`).join(", ")}</p>
								)}
								{keys.map(renderField)}
							</section>
						);
					})}
					{other.length > 0 && (
						<section className="flex flex-col gap-2 rounded-md border p-3" data-testid="section-other">
							<h2 className="text-sm font-medium">Other</h2>
							{other.map(renderField)}
						</section>
					)}
					<div className="flex items-center gap-3">
						<button className="rounded border px-3 py-1 text-sm disabled:opacity-50" disabled={!dirtyCount} onClick={() => void save()} data-testid="settings-save">Save{dirtyCount ? ` (${dirtyCount})` : ""}</button>
						{saved && <span className="text-xs text-muted-foreground" data-testid="settings-saved">Saved. Takes effect after a restart.</span>}
						{formError && <span className="text-sm text-destructive" role="alert" data-testid="settings-form-error">{formError}{formError.startsWith("This wolf") && " "}</span>}
					</div>

					<section className="flex flex-col gap-2 rounded-md border p-3" data-testid="section-env">
						<h2 className="text-sm font-medium">Environment</h2>
						<table className="w-full text-xs">
							<tbody>
								{view.env.map((e) => {
									const id = `env:${e.name}`;
									return (
										<tr key={e.name} className="border-t align-top" data-testid={`env-${e.name}`}>
											<td className="py-1 pr-3 font-mono">{e.name}{e.secret && <span className="ml-1 rounded bg-accent px-1" data-testid={`env-secret-${e.name}`}>secret</span>}</td>
											<td className="py-1 pr-3">{revealed[id] ?? (e.set ? "set" : "not set")}</td>
											<td className="py-1 pr-3 text-muted-foreground">{e.purpose}</td>
											<td className="py-1">
												{e.secret && e.set && revealed[id] === undefined && (confirming === id ? (
													<span className="flex gap-2">
														<button className="underline" data-testid={`reveal-confirm-env-${e.name}`} onClick={() => void reveal("env", e.name)}>Show the value</button>
														<button className="underline" onClick={() => setConfirming("")}>Cancel</button>
													</span>
												) : (
													<button className="underline" data-testid={`reveal-env-${e.name}`} onClick={() => setConfirming(id)}>Reveal</button>
												))}
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</section>

					<section className="flex flex-col gap-2 rounded-md border p-3" data-testid="section-config">
						<h2 className="text-sm font-medium">Full config (wolf.yaml, read-only)</h2>
						{renderConfig(view.config, "", 0)}
					</section>
				</>
			)}
		</main>
	);
}
