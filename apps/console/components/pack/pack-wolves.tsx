"use client";

/**
 * The Wolves section of the Pack panel (work-wolfpack-eE5FKDy): wolves grouped by machine; a wolf's detail shows its transport (read
 * only), its chat and memory model pickers, its domains, the keys it needs, and its prompts (view only, with scope chips).
 * Keys belong to machines: a picker offers only providers keyed on the wolf's own machine. A subscription wolf's chat needs no Pack key.
 * A save changes one wolf's wolf.yaml through /api/wolves/:name/settings (If-Match); it restarts nothing.
 * dev: ?packFixture=wolves | wolves-relay (components/pack/pack-wolves-fixtures.ts).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeftIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { PromptGraphCanvas } from "@/components/settings/prompt-graph-view";
import {
	buildGraphs,
	filterByScope,
	groupWolves,
	keysNeeded,
	mainProviderOf,
	memoryIgnoredOn,
	modelPickers,
	PROMPT_SCOPES,
	promptScope,
	saveMessage,
	SCOPE_GRAPH,
	settingsAnswerFor,
	sizeText,
	sourceText,
	transportLabel,
	wolfAccess,
	type ConsoleReach,
	type KeyMachine,
	type MachineWolf,
	type Picker,
	type PickerModel,
	type PromptScope,
} from "@/src/core";

type Fetcher = typeof fetch;
/** Looked up per call: the hub-auth wrapper replaces window.fetch and adds the device token. */
const liveFetch: Fetcher = (u, i) => fetch(u, i);
const BTN = "rounded-sm border px-2.5 py-1 text-xs transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50 max-md:min-h-11 max-md:px-3 max-md:py-2";
const SELECT = "rounded-sm border bg-background px-2 py-1 text-xs max-md:py-2 max-md:min-h-11 max-md:text-base";

interface SettingsView {
	etag: string;
	config: Record<string, unknown>;
	editable: string[];
	restartNeeded: boolean;
	/** The pi provider each tier runs on (absent on older wolves). */
	tierProviders?: Record<string, string>;
}
interface PromptRow {
	id: string;
	group: string;
	label: string;
	text: string;
	source: "default" | "override";
	file?: string;
}

const getAt = (o: Record<string, unknown>, path: string): unknown => path.split(".").reduce<unknown>((c, k) => (c && typeof c === "object" ? (c as Record<string, unknown>)[k] : undefined), o);

/** One picker: a select of the offered models, or the plain reason there is none. */
function PickerField({ label, picker, current, editable, onPick, testid, hint, note }: { note?: string; label: string; picker: Picker; current: string; editable: boolean; onPick: (id: string) => void; testid: string; hint?: string }) {
	return (
		<div className="flex flex-col gap-1" data-testid={testid}>
			<span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
			{picker.kind === "options" ? (
				<select aria-label={label} className={SELECT} value={current} disabled={!editable} onChange={(e) => onPick(e.target.value)}>
					{!picker.models.some((m) => m.id === current) ? <option value={current}>{current || "(not set)"}</option> : null}
					{picker.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
				</select>
			) : picker.kind === "subscription" ? (
				<p>Runs on the Claude subscription. No Pack key is used or needed.{current ? ` Model: ${current}.` : ""}</p>
			) : picker.kind === "nokey" ? (
				<p className="text-destructive" data-testid={`${testid}-nokey`}>This machine has no {picker.provider} key, so there is nothing to choose. Add one in Keys.{current ? ` Set now: ${current}.` : ""}</p>
			) : (
				<p className="text-muted-foreground">This machine is offline or can&apos;t take keys, so its keys are not known.</p>
			)}
			{note ? <p className="text-muted-foreground" data-testid={`${testid}-ignored`}>{note}</p> : null}
			{picker.kind === "options" && !editable && !note ? <p className="text-muted-foreground" data-testid={`${testid}-old`}>This wolf&apos;s version can&apos;t change it from here.</p> : null}
			{picker.kind === "options" && hint ? <p className="text-muted-foreground">{hint}</p> : null}
		</div>
	);
}

function WolfDetail(props: { machine: KeyMachine; wolf: MachineWolf; catalog: PickerModel[]; reach: ConsoleReach | undefined; call: Fetcher; onBack: () => void }) {
	const { machine, wolf, catalog, call } = props;
	const access = wolfAccess(props.reach, machine, wolf.name);
	const base = `/api/wolves/${encodeURIComponent(wolf.name)}/settings`;
	const [view, setView] = useState<SettingsView | null>(null);
	const [rows, setRows] = useState<PromptRow[]>([]);
	const [error, setError] = useState("");
	const [saved, setSaved] = useState(false);
	const [scope, setScope] = useState<PromptScope>("all");
	const [node, setNode] = useState<string | null>(null);

	const reachable = access.reachable;
	const load = useCallback(async () => {
		if (!reachable) return; // never load a wolf this console cannot address: the name might reach another wolf
		setError("");
		try {
			const r = await call(base);
			if (!r.ok) return setError(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? `The wolf's settings did not load (${r.status}).`);
			const v = (await r.json()) as SettingsView;
			if (!settingsAnswerFor(wolf.name, v.config)) return setError(`The answer was not from ${wolf.name}, so nothing is shown or saved.`);
			setView(v);
		} catch {
			setError("This console's server is not answering.");
			return;
		}
		void call(`/api/wolves/${encodeURIComponent(wolf.name)}/prompts`).then(async (r) => (r.ok ? setRows(((await r.json()) as { prompts: PromptRow[] }).prompts) : setRows([]))).catch(() => setRows([]));
	}, [base, call, wolf.name, reachable]);
	useEffect(() => void load(), [load]);

	const save = async (key: string, value: string) => {
		if (!view || !reachable) return;
		setSaved(false);
		try {
			const r = await call(base, { method: "PUT", headers: { "Content-Type": "application/json", "If-Match": view.etag }, body: JSON.stringify({ set: { [key]: value } }) });
			const body = (await r.json().catch(() => null)) as (SettingsView & { error?: string }) | null;
			const msg = saveMessage(r.status, body, wolf.name);
			if (!msg.ok) return setError(msg.text);
			if (!body || !settingsAnswerFor(wolf.name, body.config)) return setError(`The answer was not from ${wolf.name}. Reload to see the current values.`);
			setError("");
			setView(body);
			setSaved(true);
		} catch {
			setError(saveMessage("network", null, wolf.name).text);
		}
	};

	const chatProvider = mainProviderOf(view?.config ?? {}, view?.tierProviders);
	const memoryIgnored = memoryIgnoredOn(view?.tierProviders);
	const pickers = modelPickers(machine, wolf, catalog, chatProvider);
	const needed = keysNeeded(machine, wolf);
	const domains = (view?.config.domains as string[] | undefined) ?? [];
	const canEdit = (k: string) => !!view?.editable.includes(k);
	const graph = useMemo(() => {
		const flow = rows.map((r) => ({ id: r.id, group: r.group, label: r.label, editable: false, text: r.text, file: r.file }));
		const gs = buildGraphs(flow, null);
		return gs.find((g) => g.key === SCOPE_GRAPH[scope]) ?? gs[0]!;
	}, [rows, scope]);
	const shown = filterByScope(rows, scope).filter((r) => !node || (graph.nodes.find((n) => n.id === node)?.ids ?? []).includes(r.id));

	return (
		<div data-testid={`wolf-detail-${wolf.name}`} className="flex min-w-0 flex-col gap-4">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<button type="button" className={cn(BTN, "inline-flex items-center gap-1")} onClick={props.onBack} data-testid="wolf-back"><ArrowLeftIcon className="size-3.5" aria-hidden />Wolves</button>
				<h3 className="text-sm font-medium text-foreground">{wolf.name}</h3>
				<span className="text-muted-foreground">on {machine.machine}</span>
			</div>
			{error ? <p role="alert" data-testid="wolf-error" className="text-destructive">{error}</p> : null}
			<section className="flex flex-col gap-3 rounded-md border p-3" data-testid="wolf-models">
				<h4 className="font-medium text-foreground">Models</h4>
				<p data-testid="wolf-transport">Runs on: <span className="text-foreground">{transportLabel(wolf.transport)}</span> <span className="text-muted-foreground">(set in wolf.yaml, not here)</span></p>
				{!access.reachable ? <p data-testid="wolf-readonly" className="text-muted-foreground">{access.note}</p> : null}
				{access.reachable ? <PickerField label="Chat" testid="picker-chat" picker={pickers.chat} current={String(getAt(view?.config ?? {}, "models.main.model") ?? "")} editable={canEdit("models.main.model")} onPick={(id) => void save("models.main.model", id)} /> : null}
				{access.reachable ? <PickerField label="Memory" testid="picker-memory" hint="Used for memory's main steps; quick steps keep the fast model." picker={pickers.memory} current={String(getAt(view?.config ?? {}, "memory.model") ?? "")} editable={canEdit("memory.model") && !memoryIgnored} note={memoryIgnored ? `Memory runs on ${memoryIgnored} for this wolf; this setting has no effect.` : undefined} onPick={(id) => void save("memory.model", id)} /> : null}
				{saved ? <p data-testid="wolf-saved" className="text-muted-foreground">Saved for {wolf.name} only. It takes effect when {wolf.name} restarts.</p> : null}
			</section>
			<section className="flex flex-col gap-1 rounded-md border p-3" data-testid="wolf-domains">
				<h4 className="font-medium text-foreground">Domains</h4>
				<p>{domains.length ? domains.join(", ") : "None subscribed."}</p>
			</section>
			<section className="flex flex-col gap-1 rounded-md border p-3" data-testid="wolf-keys">
				<h4 className="font-medium text-foreground">Keys it needs (on {machine.machine})</h4>
				{needed.map((k) => (
					<p key={k.capability} data-testid={`wolf-key-${k.capability}`} className={cn(k.missing && "text-destructive")}>
						{k.capability === "chat" ? "Chat" : "Memory"} · {k.provider}: {k.state === "subscription" ? "none needed (Claude subscription)" : k.state === "unknown" ? "not known" : k.missing ? "missing, add it in Keys" : `${k.masked ?? "set"}`}
					</p>
				))}
			</section>
			<section className="flex min-w-0 flex-col gap-2 rounded-md border p-3" data-testid="wolf-prompts">
				<h4 className="font-medium text-foreground">Prompts <span className="font-normal text-muted-foreground">(view only)</span></h4>
				<div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Prompt scope">
					{PROMPT_SCOPES.map((s) => <button key={s.key} role="tab" aria-selected={scope === s.key} data-testid={`scope-${s.key}`} className={cn(BTN, scope === s.key && "bg-accent")} onClick={() => (setScope(s.key), setNode(null))}>{s.label}</button>)}
				</div>
				<div className="h-[320px] min-w-0 rounded-md border"><PromptGraphCanvas graph={graph} selected={node} onSelect={setNode} /></div>
				<ul className="flex flex-col gap-1.5" data-testid="wolf-prompt-list">
					{shown.map((r) => (
						<li key={r.id} className="rounded-sm border p-2" data-testid={`prompt-${r.id}`}>
							<p className="text-foreground">{r.label} <span className="text-muted-foreground">· {promptScope(r.id)}</span></p>
							<p className="text-muted-foreground">{sourceText(r)}</p>
							<p className="text-muted-foreground">{sizeText(r.text)}</p>
						</li>
					))}
					{shown.length === 0 ? <li className="text-muted-foreground">No prompts in this scope.</li> : null}
				</ul>
			</section>
		</div>
	);
}

export function WolvesView(props: { machines: KeyMachine[]; catalog: PickerModel[]; reach?: ConsoleReach; call: Fetcher }) {
	const [sel, setSel] = useState<{ hostId: string; name: string } | null>(null);
	const groups = groupWolves(props.machines);
	const m = sel ? props.machines.find((x) => x.hostId === sel.hostId) : undefined;
	const w = sel ? m?.wolves?.find((x) => x.name === sel.name) : undefined;
	if (sel && m && w) return <WolfDetail key={`${sel.hostId}/${sel.name}`} machine={m} wolf={w} catalog={props.catalog} reach={props.reach} call={props.call} onBack={() => setSel(null)} />;
	if (groups.length === 0) return <p className="text-xs text-muted-foreground">No wolves have reported yet.</p>;
	return (
		<div data-testid="pack-wolves" className="flex flex-col gap-4 text-xs">
			{groups.map((g) => (
				<section key={g.hostId} data-testid={`wolves-machine-${g.hostId}`}>
					<h3 className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">{g.machine}{g.online ? "" : " (offline)"}</h3>
					<ul className="flex flex-col gap-1">
						{g.wolves.map((x) => (
							<li key={x.name}>
								<button type="button" data-testid={`wolf-row-${x.name}`} className="flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left hover:bg-accent max-md:min-h-11 max-md:py-3" onClick={() => setSel({ hostId: g.hostId, name: x.name })}>
									<span className="font-medium text-foreground">{x.name}</span>
									<span className="text-muted-foreground">{transportLabel(x.transport)}</span>
								</button>
							</li>
						))}
					</ul>
				</section>
			))}
		</div>
	);
}

export function WolvesBody() {
	const [io, setIo] = useState<Fetcher | null>(null);
	const [data, setData] = useState<{ machines: KeyMachine[]; catalog: PickerModel[]; reach?: ConsoleReach } | { error: string } | null>(null);
	useEffect(() => {
		const search = window.location?.search ?? "";
		if (process.env.NODE_ENV === "production" || !/[?&]packFixture=wolves/.test(search)) return setIo(() => liveFetch);
		void import("@/components/pack/pack-wolves-fixtures").then((m) => setIo(() => { const mode = m.wolvesFixtureFromUrl(search); return mode ? m.fixtureWolvesFetch(mode) : liveFetch; }));
	}, []);
	useEffect(() => {
		if (!io) return;
		void (async () => {
			try {
				const [k, c] = await Promise.all([io("/api/pack/machines/keys", { cache: "no-store" }), io("/api/pack/model-options")]);
				const kb = (await k.json()) as { machines?: KeyMachine[]; console?: ConsoleReach; error?: string };
				if (!k.ok || !kb.machines) return setData({ error: kb.error ?? `The console answered ${k.status}.` });
				setData({ machines: kb.machines, ...(kb.console ? { reach: kb.console } : {}), catalog: c.ok ? ((await c.json()) as { models: PickerModel[] }).models : [] });
			} catch {
				setData({ error: "This console's server is not answering." });
			}
		})();
	}, [io]);
	if (!io || !data) return <p className="text-xs text-muted-foreground">Loading wolves…</p>;
	if ("error" in data) return <p data-testid="wolves-error" className="text-xs text-destructive">{data.error}</p>;
	return <WolvesView machines={data.machines} catalog={data.catalog} reach={data.reach} call={io} />;
}
