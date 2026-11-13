"use client";

/**
 * The Domains tab of the Pack panel (work-wolfpack-I2AysMu): list, add, edit (label, description, colour) and delete KB domains
 * through this console's /api/pack/domains (owner gate + hub call; src/server/pack/domains-api.ts). The name cannot change.
 * Subscriptions are not here: they stay in each wolf's settings.
 * dev: ?packFixture=domains | domains-delete-subscribed | domains-hub-down | domains-duplicate (components/pack/pack-domains-fixtures.ts).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface Domain {
	name: string;
	label?: string;
	description?: string;
	color?: string;
	created?: string;
}
type Fetcher = typeof fetch;

const BTN = "rounded-sm px-2.5 py-1 text-xs transition-colors max-md:min-h-11 max-md:px-3 max-md:py-2";
const QUIET = cn(BTN, "border text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50");
const DANGER = cn(BTN, "border border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/20 disabled:opacity-50");
const INPUT = "w-full rounded-sm border bg-background px-2 py-1 text-xs max-md:py-2 max-md:min-h-11 max-md:text-base";
const NAME_OK = /^[a-z0-9]{1,32}$/;
const DEFAULT_COLOR = "#3b82f6";

/** Plain words from a failed call: the server's own sentence, else a fallback for a console that did not answer. */
async function failureText(r: Response | null): Promise<string> {
	if (!r) return "This console's server is not answering. Try again in a moment.";
	try {
		const b = (await r.json()) as { error?: unknown };
		if (typeof b.error === "string") return b.error;
	} catch {
		/* not JSON */
	}
	return r.status === 401 ? "Sign in on this device first." : `That did not work (error ${r.status}).`;
}

/** The fetcher to use, and whether it is settled: the first load waits for a dev fixture fetcher so it never hits the real endpoint first. */
function useFetcher(): { call: Fetcher; ready: boolean } {
	const [fx, setFx] = useState<Fetcher | null>(null);
	const [ready, setReady] = useState(false);
	useEffect(() => {
		const search = window.location?.search ?? "";
		if (process.env.NODE_ENV === "production" || !/[?&]packFixture=/.test(search)) return setReady(true);
		void import("@/components/pack/pack-domains-fixtures").then((m) => {
			const f = m.domainFixtureFromUrl(search);
			if (f) setFx(() => m.fixtureDomainsFetch(f));
			setReady(true);
		}, () => setReady(true));
	}, []);
	// looked up per call: the hub-auth wrapper replaces window.fetch and adds the device bearer to /api/ calls
	const call = useCallback<Fetcher>((url, init) => (fx ?? fetch)(url, init), [fx]);
	return { call, ready };
}

function Swatch({ color }: { color?: string }) {
	return <span aria-hidden className="size-3.5 shrink-0 rounded-full border" style={{ background: color || "transparent" }} />;
}

export function DomainsTab() {
	const { call, ready } = useFetcher();
	const [rows, setRows] = useState<Domain[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const load = useCallback(async () => {
		let r: Response | null = null;
		try {
			r = await call("/api/pack/domains", { cache: "no-store" });
		} catch {
			r = null;
		}
		if (r?.ok) {
			setRows(((await r.json()) as { domains: Domain[] }).domains);
			setLoadError(null);
		} else setLoadError(await failureText(r));
	}, [call]);
	useEffect(() => { if (ready) void load(); }, [ready, load]);

	return (
		<div data-testid="pack-domains" className="flex flex-col gap-3">
			<AddForm call={call} onDone={load} />
			{loadError && <p data-testid="pack-domains-load-error" className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-red-700 dark:text-red-300">{loadError}</p>}
			{rows === null && !loadError && <p className="text-muted-foreground">Loading domains…</p>}
			{rows?.length === 0 && <p className="text-muted-foreground">No domains yet.</p>}
			<ul className="flex flex-col gap-1.5">
				{rows?.map((d) => <DomainRow key={d.name} domain={d} call={call} onDone={load} />)}
			</ul>
			<p className="text-muted-foreground/70">Which wolves read a domain is set in each wolf's settings. Deleting a domain keeps its knowledge files.</p>
		</div>
	);
}

function ColorInput({ value, onChange, id }: { value: string; onChange: (v: string) => void; id: string }) {
	return <input id={id} type="color" aria-label="Colour" value={value} onChange={(e) => onChange(e.target.value)} className="h-7 w-10 shrink-0 cursor-pointer rounded-sm border bg-background p-0.5 max-md:h-9" />;
}

function AddForm({ call, onDone }: { call: Fetcher; onDone: () => Promise<void> }) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [label, setLabel] = useState("");
	const [description, setDescription] = useState("");
	const [color, setColor] = useState(DEFAULT_COLOR);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const nameRef = useRef<HTMLInputElement>(null);
	useEffect(() => { if (open) nameRef.current?.focus(); }, [open]);

	if (!open) return <div><button type="button" data-testid="pack-domain-add" onClick={() => setOpen(true)} className={QUIET}>Add domain</button></div>;

	const nameBad = name !== "" && !NAME_OK.test(name);
	const submit = async () => {
		if (!NAME_OK.test(name)) return setError("Domain names are lower-case letters and digits only, up to 32 (no hyphens).");
		setBusy(true);
		setError(null);
		let r: Response | null = null;
		try {
			r = await call("/api/pack/domains", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, ...(label.trim() && { label: label.trim() }), ...(description.trim() && { description: description.trim() }), color }) });
		} catch {
			r = null;
		}
		setBusy(false);
		if (!r?.ok) return setError(await failureText(r));
		setName(""); setLabel(""); setDescription(""); setColor(DEFAULT_COLOR); setOpen(false);
		await onDone();
	};
	return (
		<form data-testid="pack-domain-add-form" onSubmit={(e) => { e.preventDefault(); void submit(); }} className="flex flex-col gap-2 rounded-lg border bg-card px-3 py-2.5">
			<h3 className="text-xs font-semibold">Add a domain</h3>
			<label className="flex flex-col gap-1">Name
				<input ref={nameRef} data-testid="pack-domain-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={32} autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-invalid={nameBad} className={INPUT} />
				<span className={nameBad ? "text-red-600 dark:text-red-400" : "text-muted-foreground/70"}>Lower-case letters and digits only, up to 32. It can't be changed later.</span>
			</label>
			<label className="flex flex-col gap-1">Label
				<input data-testid="pack-domain-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={200} className={INPUT} />
			</label>
			<label className="flex flex-col gap-1">Description
				<textarea data-testid="pack-domain-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} rows={2} className={INPUT} />
			</label>
			<div className="flex items-center gap-2">Colour <ColorInput id="pack-domain-new-color" value={color} onChange={setColor} /></div>
			{error && <p data-testid="pack-domain-add-error" role="alert" className="text-red-600 dark:text-red-400">{error}</p>}
			<div className="flex gap-2">
				<button type="submit" data-testid="pack-domain-add-save" disabled={busy || name === "" || nameBad} className={QUIET}>{busy ? "Adding…" : "Add"}</button>
				<button type="button" disabled={busy} onClick={() => { setOpen(false); setError(null); }} className={QUIET}>Cancel</button>
			</div>
		</form>
	);
}

type Mode = { kind: "view" } | { kind: "edit" } | { kind: "confirm" };

function DomainRow({ domain, call, onDone }: { domain: Domain; call: Fetcher; onDone: () => Promise<void> }) {
	const [mode, setMode] = useState<Mode>({ kind: "view" });
	const [label, setLabel] = useState(domain.label ?? "");
	const [description, setDescription] = useState(domain.description ?? "");
	const [color, setColor] = useState(domain.color || DEFAULT_COLOR);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const send = async (init: RequestInit) => {
		setBusy(true);
		setError(null);
		let r: Response | null = null;
		try {
			r = await call(`/api/pack/domains/${encodeURIComponent(domain.name)}`, init);
		} catch {
			r = null;
		}
		setBusy(false);
		if (!r?.ok) {
			setError(await failureText(r));
			return false;
		}
		await onDone();
		return true;
	};
	const save = async () => {
		if (await send({ method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label, description, color }) })) setMode({ kind: "view" });
	};
	const remove = async () => {
		if (!(await send({ method: "DELETE" }))) setMode({ kind: "view" }); // on success the row is gone; on refusal the message stays on the row
	};

	return (
		<li data-testid="pack-domain-row" data-domain={domain.name} className="rounded-lg border bg-card px-3 py-2">
			<div className="flex items-start gap-2">
				<span className="mt-0.5"><Swatch color={domain.color} /></span>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-baseline gap-x-2">
						<span className="font-mono font-semibold">{domain.name}</span>
						{domain.label && <span>{domain.label}</span>}
						{domain.created && <span className="text-muted-foreground/70">added {domain.created}</span>}
					</div>
					{domain.description && <p className="break-words text-muted-foreground">{domain.description}</p>}
				</div>
				{mode.kind === "view" && (
					<span className="flex shrink-0 flex-wrap justify-end gap-1">
						<button type="button" data-testid="pack-domain-edit" onClick={() => { setError(null); setLabel(domain.label ?? ""); setDescription(domain.description ?? ""); setColor(domain.color || DEFAULT_COLOR); setMode({ kind: "edit" }); }} className={QUIET}>Edit</button>
						<button type="button" data-testid="pack-domain-delete" onClick={() => { setError(null); setMode({ kind: "confirm" }); }} className={QUIET}>Delete</button>
					</span>
				)}
			</div>
			{mode.kind === "edit" && (
				<form data-testid="pack-domain-edit-form" onSubmit={(e) => { e.preventDefault(); void save(); }} className="mt-2 flex flex-col gap-2 border-t pt-2">
					<p className="text-muted-foreground/70">The name <span className="font-mono">{domain.name}</span> can't be changed.</p>
					<label className="flex flex-col gap-1">Label <input data-testid="pack-domain-edit-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={200} className={INPUT} /></label>
					<label className="flex flex-col gap-1">Description <textarea data-testid="pack-domain-edit-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} rows={2} className={INPUT} /></label>
					<div className="flex items-center gap-2">Colour <ColorInput id={`pack-domain-color-${domain.name}`} value={color} onChange={setColor} /></div>
					<div className="flex gap-2">
						<button type="submit" data-testid="pack-domain-edit-save" disabled={busy} className={QUIET}>{busy ? "Saving…" : "Save"}</button>
						<button type="button" disabled={busy} onClick={() => { setMode({ kind: "view" }); setError(null); }} className={QUIET}>Cancel</button>
					</div>
				</form>
			)}
			{mode.kind === "confirm" && (
				<div data-testid="pack-domain-confirm" className="mt-2 flex flex-wrap items-center gap-2 border-t pt-2">
					<span>Delete the domain <span className="font-mono font-semibold">{domain.name}</span>? Its knowledge files are kept.</span>
					<button type="button" data-testid="pack-domain-delete-confirm" disabled={busy} onClick={() => void remove()} className={DANGER}>{busy ? "Deleting…" : `Delete ${domain.name}`}</button>
					<button type="button" disabled={busy} onClick={() => setMode({ kind: "view" })} className={QUIET}>Cancel</button>
				</div>
			)}
			{error && <p data-testid="pack-domain-error" role="alert" className="mt-1.5 break-words text-red-600 dark:text-red-400">{error}</p>}
		</li>
	);
}
