"use client";

/**
 * Pack > Wolves > a wolf > All settings (work-wolfpack-u6GH2kk). The old Settings dialog's Wolf settings tab, folded into the wolf's detail:
 * colour, models and tiers, subagents, compaction and memory, a Restart button with its countdown and the pending/needed banners, the
 * environment variable names and the wolf.yaml read-out with Reveal behind a confirm. The wolf's view (`view`) is owned by the parent
 * (WolfDetail), so a save here or from the Chat/Memory pickers above refreshes the other through `onView`.
 * Left out on purpose: models.main.model, models.main.provider and memory.model, which the Pack's own pickers own.
 * Every call goes through `call` (the hub-auth fetch) to /api/wolves/:name/settings*, with If-Match on saves. The parent renders this
 * only for a wolf this console can reach.
 */
import { useEffect, useRef, useState } from "react";
import { ThreadColorPicker } from "@/components/settings/thread-color-picker";
import { THREAD_COLORS, autoThreadColor, buildPayload, fieldKind, getAt, parseIssues, retryAfterSeconds, type Draft } from "@/src/core";

export interface WolfSettingsView {
	etag: string;
	config: Record<string, unknown>;
	editable: string[];
	tierModels?: Record<string, string>;
	env?: { name: string; set: boolean; secret: boolean; purpose: string }[];
	restartNeeded: boolean;
	restartable?: boolean;
	restartAvailableInSeconds?: number;
	/** The pi provider each tier runs on (absent on older wolves). */
	tierProviders?: Record<string, string>;
}

/** The three keys the Pack's Chat and Memory pickers own. */
const OWNED_BY_PICKERS = new Set(["models.main.model", "models.main.provider", "memory.model"]);
/** Editable on the wolf, but not offered in the Pack: structured-output editing was dropped with the Prompts editor. */
const NOT_IN_PACK = new Set(["prompts.structuredOutput"]);

const SECTIONS: { id: string; title: string; match: (k: string) => boolean }[] = [
	{ id: "color", title: "Color", match: (k) => k === "color" },
	{ id: "models", title: "Models and tiers", match: (k) => k.startsWith("models.") || k.startsWith("tiers.") },
	{ id: "subagents", title: "Subagents", match: (k) => k.startsWith("subagents.") },
	{ id: "compaction", title: "Compaction", match: (k) => k.startsWith("compaction.") },
	{ id: "memory", title: "Memory", match: (k) => k.startsWith("memory.") },
];

type Fetcher = typeof fetch;

async function readError(r: Response): Promise<{ message: string; details?: Record<string, unknown> }> {
	const b = (await r.json().catch(() => null)) as { error?: string; message?: string; details?: Record<string, unknown> } | null;
	return { message: b?.error ?? b?.message ?? `request failed (${r.status})`, details: b?.details };
}

const isMasked = (v: unknown): v is { set: boolean } =>
	!!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && typeof (v as { set?: unknown }).set === "boolean";

const CHANGED = "This wolf's config changed since you loaded it. Reload to see the current values.";

export function WolfAllSettings(props: { wolfName: string; view: WolfSettingsView; call: Fetcher; onView: (v: WolfSettingsView) => void; onReload: () => void }) {
	const { wolfName: wolf, view, call } = props;
	const base = `/api/wolves/${encodeURIComponent(wolf)}/settings`;
	const [drafts, setDrafts] = useState<Record<string, Draft>>({});
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [formError, setFormError] = useState("");
	const [revealed, setRevealed] = useState<Record<string, string>>({});
	const [confirming, setConfirming] = useState("");
	const [pending, setPending] = useState(false);
	const [restartError, setRestartError] = useState("");
	const [wait, setWait] = useState(view.restartAvailableInSeconds ?? 0);
	const [saved, setSaved] = useState(false);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const mounted = useRef(true);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			if (pollRef.current) clearInterval(pollRef.current);
		};
	}, []);
	// A new view (a picker save above, a reload) carries a fresh restart window.
	useEffect(() => setWait(view.restartAvailableInSeconds ?? 0), [view]);
	// Countdown to the earliest allowed restart.
	useEffect(() => {
		if (wait <= 0) return;
		const t = setTimeout(() => setWait((w) => Math.max(0, w - 1)), 1000);
		return () => clearTimeout(t);
	}, [wait]);

	const save = async () => {
		const { set, invalid } = buildPayload(view.config, drafts);
		setErrors(invalid);
		setFormError("");
		setSaved(false);
		if (Object.keys(invalid).length || !Object.keys(set).length) return;
		try {
			const r = await call(base, { method: "PUT", headers: { "Content-Type": "application/json", "If-Match": view.etag }, body: JSON.stringify({ set }) });
			if (!r.ok) {
				const e = await readError(r);
				if (r.status === 409) return setFormError(CHANGED);
				if (r.status === 400) {
					// Only keys this form renders can show an inline error; anything else goes to the form error so it is seen.
					const rendered = (k: string) => view.editable.includes(k) && !OWNED_BY_PICKERS.has(k) && !NOT_IN_PACK.has(k);
					const issues = Object.entries(parseIssues(e.message));
					const known = Object.fromEntries(issues.filter(([k]) => rendered(k)));
					const hidden = issues.filter(([k]) => !rendered(k));
					setErrors(known);
					return setFormError(hidden.length || !Object.keys(known).length ? e.message : "");
				}
				return setFormError(e.message);
			}
			const v = (await r.json()) as WolfSettingsView;
			if (v.config.name !== wolf) return setFormError(`The answer was not from ${wolf}. Reload to see the current values.`);
			props.onView(v);
			setDrafts({});
			setSaved(true);
		} catch {
			setFormError("This console's server is not answering.");
		}
	};

	/** The wolf's one color: saved at once (no Save button), null = automatic. */
	const saveColor = async (key: string | null) => {
		setFormError("");
		try {
			const r = await call(base, { method: "PUT", headers: { "Content-Type": "application/json", "If-Match": view.etag }, body: JSON.stringify({ set: { color: key } }) });
			if (!r.ok) return setFormError(r.status === 409 ? CHANGED : (await readError(r)).message);
			const v = (await r.json()) as WolfSettingsView;
			if (v.config.name === wolf) props.onView(v);
		} catch {
			setFormError("This console's server is not answering.");
		}
	};

	const reveal = async (source: "env" | "config", name: string) => {
		const r = await call(`${base}/reveal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source, name }) });
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
		const r = await call(`${base}/restart`, { method: "POST" });
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
			void call(base)
				.then(async (res) => {
					if (!res.ok) return void (seenDown = true);
					if (!seenDown && Date.now() - started < 8000) return;
					if (pollRef.current) clearInterval(pollRef.current);
					if (!mounted.current) return;
					setPending(false);
					const v = (await res.json()) as WolfSettingsView;
					if (!mounted.current) return;
					props.onView(v);
					setWait(v.restartAvailableInSeconds ?? 0);
					setDrafts({});
					setRevealed({});
				})
				.catch(() => void (seenDown = true));
		}, 2000);
	};

	const renderField = (key: string) => {
		const k = fieldKind(key);
		const current = getAt(view.config, key);
		const draft = drafts[key];
		const dirty = key in drafts;
		const set = (d: Draft) => setDrafts((m) => ({ ...m, [key]: d }));
		const cleared = draft === null;
		const text = typeof draft === "string" ? draft : current === undefined || current === null ? "" : String(current);
		const common = { "aria-label": key, "data-testid": `field-${key}`, disabled: cleared, className: "rounded border bg-background px-2 py-1 text-sm disabled:opacity-50 max-md:min-h-11 max-md:text-base" };
		return (
			<div key={key} className="flex flex-col gap-1" data-testid={`row-${key}`}>
				<div className="flex flex-wrap items-center gap-2">
					<label className="w-full shrink-0 break-all font-mono text-xs text-muted-foreground sm:w-72" htmlFor={`f-${key}`}>{key}</label>
					{k.kind === "boolean" ? (
						<label className="flex items-center max-md:min-h-11 max-md:min-w-11 max-md:justify-center">
							<input id={`f-${key}`} type="checkbox" {...common} className="size-4" checked={typeof draft === "boolean" ? draft : current === true} onChange={(e) => set(e.target.checked)} />
						</label>
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
						<button type="button" className="text-xs underline max-md:min-h-11" data-testid={`clear-${key}`} onClick={() => set(cleared ? (current === undefined ? "" : String(current)) : null)}>
							{cleared ? "undo clear" : "clear"}
						</button>
					)}
					{dirty && <span className="text-xs text-muted-foreground">{cleared ? "will be removed" : "edited"}</span>}
				</div>
				{errors[key] && <p className="text-xs text-destructive" role="alert" data-testid={`error-${key}`}>{errors[key]}</p>}
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
						<li key={k} className="break-all font-mono text-xs">
							<span className="text-muted-foreground">{k}:</span> {renderConfig(v, path ? `${path}.${k}` : k, depth + 1)}
						</li>
					))}
				</ul>
			);
		}
		return <span>{value === null ? "null" : JSON.stringify(value)}</span>;
	};

	const editable = view.editable.filter((k) => !OWNED_BY_PICKERS.has(k) && !NOT_IN_PACK.has(k));
	const other = editable.filter((k) => !SECTIONS.some((s) => s.match(k)));
	const dirtyCount = Object.keys(drafts).length;
	const restartable = view.restartable ?? false;
	const canRestart = restartable && wait <= 0 && !pending;
	const tierModels = Object.entries(view.tierModels ?? {});

	return (
		<div className="flex min-w-0 flex-col gap-3" data-testid="wolf-all-settings-form">
			{pending ? (
				<p className="rounded border border-amber-500/50 bg-amber-500/10 px-3 py-2" role="status" data-testid="banner-restart-pending">Restart pending: waiting for {wolf} to answer again…</p>
			) : view.restartNeeded ? (
				<p className="rounded border border-amber-500/50 bg-amber-500/10 px-3 py-2" role="status" data-testid="banner-restart-needed">Restart needed: wolf.yaml changed since {wolf} started, so the running wolf still has the old values.</p>
			) : null}
			<div className="flex flex-wrap items-center gap-3">
				<button className="rounded border px-3 py-1 disabled:opacity-50 max-md:min-h-11" disabled={!canRestart} onClick={() => void restart()} data-testid="restart-button">Restart {wolf}</button>
				{!restartable && <span className="text-muted-foreground" data-testid="restart-reason">Not supervised: this wolf cannot restart itself.</span>}
				{restartable && wait > 0 && <span className="text-muted-foreground" data-testid="restart-countdown">Available in {wait}s</span>}
				{restartError && <span className="text-destructive" role="alert" data-testid="restart-error">{restartError}</span>}
				<button className="rounded border px-3 py-1 max-md:min-h-11" onClick={props.onReload} data-testid="settings-reload">Reload</button>
			</div>

			{SECTIONS.map((s) => {
				const keys = editable.filter(s.match);
				if (!keys.length && s.id !== "color") return null;
				return (
					<section key={s.id} className="flex flex-col gap-2 rounded-md border p-3" data-testid={`section-${s.id}`}>
						<h5 className="font-medium text-foreground">{s.title}</h5>
						{s.id === "models" && tierModels.length > 0 && (
							<p className="text-muted-foreground" data-testid="tier-models">Running now: {tierModels.map(([t, m]) => `${t} = ${m}`).join(", ")}</p>
						)}
						{s.id === "color" ? (
							view.editable.includes("color") ? <ThreadColorPicker value={typeof view.config.color === "string" ? view.config.color : undefined} autoHex={THREAD_COLORS[autoThreadColor(`${wolf}/home`)]} onPick={(k) => void saveColor(k)} /> : <p className="text-muted-foreground">This wolf's version can&apos;t change its colour from here.</p>
						) : (
							keys.map(renderField)
						)}
					</section>
				);
			})}
			{other.length > 0 && (
				<section className="flex flex-col gap-2 rounded-md border p-3" data-testid="section-other">
					<h5 className="font-medium text-foreground">Other</h5>
					{other.map(renderField)}
				</section>
			)}
			<div className="flex flex-wrap items-center gap-3">
				<button className="rounded border px-3 py-1 disabled:opacity-50 max-md:min-h-11" disabled={!dirtyCount} onClick={() => void save()} data-testid="settings-save">Save{dirtyCount ? ` (${dirtyCount})` : ""}</button>
				{saved && <span className="text-muted-foreground" data-testid="settings-saved">Saved. Takes effect after a restart.</span>}
				{formError && <span className="text-destructive" role="alert" data-testid="settings-form-error">{formError}</span>}
			</div>

			<section className="flex flex-col gap-2 rounded-md border p-3" data-testid="section-env">
				<h5 className="font-medium text-foreground">Environment</h5>
				<div className="overflow-x-auto">
					<table className="w-full">
						<tbody>
							{(view.env ?? []).map((e) => {
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
												<button className="underline max-md:min-h-11" data-testid={`reveal-env-${e.name}`} onClick={() => setConfirming(id)}>Reveal</button>
											))}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			</section>

			<section className="flex flex-col gap-2 rounded-md border p-3" data-testid="section-config">
				<h5 className="font-medium text-foreground">Full config (wolf.yaml, read-only)</h5>
				{renderConfig(view.config, "", 0)}
			</section>
		</div>
	);
}
