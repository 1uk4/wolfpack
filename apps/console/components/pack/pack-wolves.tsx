"use client";

/**
 * The Wolves section of the Pack panel (work-wolfpack-eE5FKDy): wolves grouped by machine; a wolf's detail shows its transport (read
 * only), its chat and memory model pickers, its domains, the keys it needs, and its prompts (view only, with scope chips).
 * Keys belong to machines: a picker offers only providers keyed on the wolf's own machine. A subscription wolf's chat needs no Pack key.
 * A save changes one wolf's wolf.yaml through /api/wolves/:name/settings (If-Match); it restarts nothing.
 * dev: ?packFixture=wolves | wolves-relay (components/pack/pack-wolves-fixtures.ts).
 */
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Draft } from "@/src/core";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { PromptGraphCanvas } from "@/components/settings/prompt-graph-view";
import { PageViewer } from "@/components/viewer/page-viewer";
import { useOpenView } from "@/components/viewer/viewer-context";
import { closeViewer } from "@/components/viewer/viewer-store";
import { parseWolfPath, wolfPath, wolfRedirect, DEFAULT_WOLF_TAB } from "@/src/core";
import { VIEW_PARAM, noteUrlWrite } from "@/components/viewer/viewer-url";
import { buildPromptBlocks, PromptBlocksContext } from "@/components/viewer/renderers/prompt-view";
import { WolfAllSettings, WolfRestartBar, type WolfSectionId, type WolfSettingsView } from "@/components/pack/wolf-all-settings";
import {
	buildGraphs,
	groupWolves,
	keysNeeded,
	mainProviderOf,
	memoryIgnoredOn,
	modelPickers,
	PROMPT_SCOPES,
	saveMessage,
	SCOPE_GRAPH,
	settingsAnswerFor,
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

type SettingsView = WolfSettingsView;
interface PromptRow {
	id: string;
	group: string;
	label: string;
	text: string;
	source: "default" | "override";
	file?: string;
}

/** The switcher's option value: both parts encoded, so the first "/" is always the separator even if a host id or name contains one. */
const wolfValue = (hostId: string, name: string): string => `${encodeURIComponent(hostId)}/${encodeURIComponent(name)}`;

const getAt = (o: Record<string, unknown>, path: string): unknown => path.split(".").reduce<unknown>((c, k) => (c && typeof c === "object" ? (c as Record<string, unknown>)[k] : undefined), o);

/** The prompts graph; a node click opens that prompt block in the page's viewer. */
function PromptsGraphBox({ graph, selected, onSelect, toolbar }: { graph: Parameters<typeof PromptGraphCanvas>[0]["graph"]; selected: string | null; onSelect: (id: string) => void; toolbar?: ReactNode }) {
	const open = useOpenView();
	return <PromptGraphCanvas graph={graph} toolbar={toolbar} selected={selected} onSelect={(id) => (onSelect(id), open?.({ kind: "prompt", id }))} />;
}

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

export function WolfDetail(props: { machine: KeyMachine; wolf: MachineWolf; machines?: KeyMachine[]; catalog: PickerModel[]; reach: ConsoleReach | undefined; call: Fetcher }) {
	const { machine, wolf, catalog, call } = props;
	const access = wolfAccess(props.reach, machine, wolf.name);
	const base = `/api/wolves/${encodeURIComponent(wolf.name)}/settings`;
	const [view, setView] = useState<SettingsView | null>(null);
	const [rows, setRows] = useState<PromptRow[]>([]);
	// The hub's KB sweep and reorg prompts (read-only); null until loaded or when the hub does not answer.
	const [hubRows, setHubRows] = useState<PromptRow[] | null>(null);
	const [error, setError] = useState("");
	const [saved, setSaved] = useState(false);
	const [scope, setScope] = useState<PromptScope>("all");
	const [node, setNode] = useState<string | null>(null);
	// Unsaved edits and revealed secrets live here, not in the tab panel, so they survive tab switches; a restart clears them.
	const [drafts, setDrafts] = useState<Record<string, Draft>>({});
	const [revealed, setRevealed] = useState<Record<string, string>>({});

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
		void call("/api/hub/prompts").then(async (r) => setHubRows(r.ok ? ((await r.json()) as { prompts: PromptRow[] }).prompts : null)).catch(() => setHubRows(null));
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
	// Every row is read-only on this page by design: the wolf's own settings tabs edit the editable prompts (identity, orchestrator rules,
	// profiles), and the prompts the wolf cannot override are read-only in wolfd. So `editable: false` here is not a gap.
	const graphs = useMemo(() => {
		const flow = rows.map((r) => ({ id: r.id, group: r.group, label: r.label, editable: false, text: r.text, file: r.file }));
		const hub = hubRows?.map((r) => ({ id: r.id, group: r.group, label: r.label, editable: false, text: r.text }));
		return buildGraphs(flow, hub ?? null);
	}, [rows, hubRows]);
	const graph = useMemo(() => graphs.find((g) => g.key === SCOPE_GRAPH[scope]) ?? graphs[0]!, [graphs, scope]);
	const blocks = useMemo(() => buildPromptBlocks(graphs, [...rows, ...(hubRows ?? []).map((r) => ({ ...r, id: `hub:${r.id}`, source: "default" as const }))]), [graphs, rows, hubRows]);

	// The wolf page's tabs. One entry per tab; the last path segment picks it (Models is the default and leaves no segment).
	// An open prompt (?view=prompt:<id>) always shows the Prompts tab.
	const router = useRouter();
	const pathname = usePathname();
	const search = useSearchParams()?.toString() ?? "";
	// The settings sections a tab shows, open. One shared view and etag (this component's `view`), so a save on any tab shows on the others.
	const sectionsFor = (sections: WolfSectionId[], quiet = false): ReactNode =>
		!access.reachable ? (quiet ? null : <p data-testid="wolf-readonly" className="text-muted-foreground">{access.note}</p>) : view ? <WolfAllSettings wolfName={wolf.name} view={view} call={call} onView={setView} sections={sections} drafts={drafts} setDrafts={setDrafts} revealed={revealed} setRevealed={setRevealed} /> : error ? <p role="alert" className="text-destructive" data-testid="wolf-all-settings-error">{error}</p> : <p className="text-muted-foreground">Loading…</p>;
	const panel = (id: string, label: string, children: ReactNode): ReactNode => <div role="tabpanel" id={`wolf-panel-${id}`} aria-labelledby={`wolf-tab-${id}`} aria-label={label} className="flex min-w-0 flex-col gap-4">{children}</div>;
	const tabs: { id: string; label: string; render: () => ReactNode }[] = [
		{ id: "appearance", label: "Appearance", render: () => panel("appearance", "Appearance", sectionsFor(["color"])) },
		{
			id: "models",
			label: "Models",
			render: () =>
				panel(
					"models", "Models",
					<>
						<section className="flex flex-col gap-3 rounded-md border p-3" data-testid="wolf-models">
							<h4 className="font-medium text-foreground">Chat and Memory</h4>
							<p data-testid="wolf-transport">Runs on: <span className="text-foreground">{transportLabel(wolf.transport)}</span> <span className="text-muted-foreground">(set in wolf.yaml, not here)</span></p>
							{!access.reachable ? <p data-testid="wolf-readonly" className="text-muted-foreground">{access.note}</p> : null}
							{access.reachable ? <PickerField label="Chat" testid="picker-chat" picker={pickers.chat} current={String(getAt(view?.config ?? {}, "models.main.model") ?? "")} editable={canEdit("models.main.model")} onPick={(id) => void save("models.main.model", id)} /> : null}
							{access.reachable ? <PickerField label="Memory" testid="picker-memory" hint="Used for memory's main steps; quick steps keep the fast model." picker={pickers.memory} current={String(getAt(view?.config ?? {}, "memory.model") ?? "")} editable={canEdit("memory.model") && !memoryIgnored} note={memoryIgnored ? `Memory runs on ${memoryIgnored} for this wolf; this setting has no effect.` : undefined} onPick={(id) => void save("memory.model", id)} /> : null}
							{saved ? <p data-testid="wolf-saved" className="text-muted-foreground">Saved to wolf.yaml for {wolf.name} only. Takes effect after the wolf restarts.</p> : null}
						</section>
						{sectionsFor(["models"], true)}
						<section className="flex flex-col gap-1 rounded-md border p-3" data-testid="wolf-keys">
							<h4 className="font-medium text-foreground">Keys it needs (on {machine.machine})</h4>
							{needed.map((k) => (
								<p key={k.capability} data-testid={`wolf-key-${k.capability}`} className={cn(k.missing && "text-destructive")}>
									{k.capability === "chat" ? "Chat" : "Memory"} · {k.provider}: {k.state === "subscription" ? "none needed (Claude subscription)" : k.state === "unknown" ? "not known" : k.missing ? "missing, add it in Keys" : `${k.masked ?? "set"}`}
								</p>
							))}
						</section>
					</>,
				),
		},
		{ id: "behaviour", label: "Behaviour", render: () => panel("behaviour", "Behaviour", sectionsFor(["subagents", "compaction", "memory", "other"])) },
		{
			id: "access",
			label: "Access",
			render: () =>
				panel(
					"access", "Access",
					<>
						<section className="flex flex-col gap-1 rounded-md border p-3" data-testid="wolf-domains">
							<h4 className="font-medium text-foreground">Domains</h4>
							<p>{domains.length ? domains.join(", ") : "None subscribed."}</p>
						</section>
						{sectionsFor(["env"], true)}
					</>,
				),
		},
		{ id: "yaml", label: "wolf.yaml", render: () => panel("yaml", "wolf.yaml", sectionsFor(["config"])) },
		{
			id: "prompts",
			label: "Prompts",
			render: () => (
				<div role="tabpanel" id="wolf-panel-prompts" aria-labelledby="wolf-tab-prompts" aria-label="Prompts" className="flex min-h-0 min-w-0 flex-1 flex-col">
					<section className="flex min-h-0 min-w-0 flex-1 flex-col gap-2" data-testid="wolf-prompts">
						<div data-testid="wolf-prompts-graph" className="min-h-[22rem] min-w-0 flex-1 rounded-md border">
							<PromptsGraphBox
								graph={graph}
								selected={node}
								onSelect={setNode}
								toolbar={
									<div role="group" aria-label="Prompt scope" className="mr-auto inline-flex gap-0.5 p-0.5 max-md:overflow-x-auto">
										{PROMPT_SCOPES.map((s) => <button key={s.key} type="button" aria-pressed={scope === s.key} data-testid={`scope-${s.key}`} className={cn("shrink-0 rounded-md border px-2 py-0.5 text-xs transition-colors hover:bg-accent max-md:min-h-11 max-md:px-3", scope === s.key ? "border-foreground bg-accent font-medium text-foreground" : "border-transparent text-muted-foreground")} onClick={() => (setScope(s.key), setNode(null))}>{s.label}</button>)}
									</div>
								}
							/>
						</div>
					</section>
				</div>
			),
		},
	];
	const pathTab = parseWolfPath(pathname)?.tab ?? DEFAULT_WOLF_TAB;
	const promptOpen = (new URLSearchParams(search).get(VIEW_PARAM) ?? "").startsWith("prompt:");
	// The tab is the last path segment (/pack/wolves/<host>/<name>/<tab>, Models when absent). An open prompt always shows Prompts.
	const wantTab = promptOpen ? "prompts" : pathTab;
	const active = tabs.find((t) => t.id === wantTab) ?? tabs.find((t) => t.id === DEFAULT_WOLF_TAB)!;
	// ?view=prompt:<id> on a non-prompts path: make the URL honest (redirect to /prompts, view kept), so closing the viewer stays on Prompts.
	useEffect(() => {
		const to = wolfRedirect(pathname, search);
		if (to) router.replace(to);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [pathname, search]);
	// Whenever the path is not on Prompts (and no prompt is being deep-linked), the viewer must be closed: otherwise browser Back from
	// /prompts?view=... leaves the store open, the URL sync rewrites `view`, and the redirect above sends the user back to Prompts.
	useEffect(() => {
		if (pathTab !== "prompts" && !promptOpen) closeViewer("page", `settings:${wolf.name}`);
	}, [pathTab, promptOpen, wolf.name]);
	// A tab change is a navigation (Back steps through tabs). Leaving Prompts closes the viewer and drops `view` in the SAME write:
	// the URL sync is told the new (empty) query first, so it does not build a second replace from the stale params and undo it.
	const pickTab = (id: string) => {
		if (id !== "prompts") {
			noteUrlWrite("");
			closeViewer("page", `settings:${wolf.name}`);
		}
		router.push(wolfPath(machine.hostId, wolf.name, id));
	};
	const wolfList = (props.machines ?? [machine]).flatMap((m) => (m.wolves ?? []).map((w) => ({ hostId: m.hostId, machine: m.machine, name: w.name })));
	const manyMachines = new Set(wolfList.map((w) => w.hostId)).size > 1;
	const switchWolf = (value: string) => {
		const cut = value.indexOf("/");
		if (cut <= 0) return;
		const [hostId, name] = [decodeURIComponent(value.slice(0, cut)), decodeURIComponent(value.slice(cut + 1))];
		noteUrlWrite("");
		closeViewer("page", `settings:${wolf.name}`); // the old wolf's viewer must not write its view onto the new wolf's URL
		router.push(wolfPath(hostId, name, active.id));
	};
	// Manual activation: Arrow, Home and End only move focus (no history entry); Enter or Space (the button's click) opens the tab.
	const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
		const from = tabs.findIndex((t) => `wolf-tab-${t.id}` === e.currentTarget.id);
		const to = e.key === "ArrowRight" ? (from + 1) % tabs.length : e.key === "ArrowLeft" ? (from - 1 + tabs.length) % tabs.length : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
		if (to < 0) return;
		e.preventDefault();
		document.getElementById(`wolf-tab-${tabs[to]!.id}`)?.focus();
	};

	return (
		<PromptBlocksContext.Provider value={{ blocks: rows.length ? blocks : null }}>
		<PageViewer scope={`settings:${wolf.name}`} allowedKinds={["prompt"]} urlSync={pathTab === "prompts" || promptOpen}>
		<div data-testid={`wolf-detail-${wolf.name}`} className="flex h-full min-h-[32rem] min-w-0 flex-col gap-3">
			<div data-testid="wolf-row" className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<select aria-label="Wolf" data-testid="wolf-switcher" className={cn(SELECT, "text-sm font-medium text-foreground")} value={wolfValue(machine.hostId, wolf.name)} onChange={(e) => switchWolf(e.target.value)}>
					{manyMachines
						? [...new Set(wolfList.map((w) => w.hostId))].map((h) => <optgroup key={h} label={wolfList.find((w) => w.hostId === h)!.machine}>{wolfList.filter((w) => w.hostId === h).map((w) => <option key={w.name} value={wolfValue(h, w.name)}>{w.name}</option>)}</optgroup>)
						: wolfList.map((w) => <option key={wolfValue(w.hostId, w.name)} value={wolfValue(w.hostId, w.name)}>{w.name}</option>)}
				</select>
				<span className="text-muted-foreground">on {machine.machine}</span>
				{access.reachable && view ? <WolfRestartBar wolfName={wolf.name} view={view} call={call} onView={setView} onReload={() => void load()} onRestarted={() => (setDrafts({}), setRevealed({}))} /> : null}
			</div>
			{error ? <p role="alert" data-testid="wolf-error" className="text-destructive">{error}</p> : null}
			<div role="tablist" aria-label="Wolf page" className="flex shrink-0 gap-1 overflow-x-auto border-b">
				{tabs.map((t) => <button key={t.id} id={`wolf-tab-${t.id}`} type="button" role="tab" aria-controls={`wolf-panel-${t.id}`} aria-selected={t.id === active.id} tabIndex={t.id === active.id ? 0 : -1} data-testid={`wolf-tab-${t.id}`} className={cn("shrink-0 border-b-2 px-3 py-1.5 text-xs transition-colors hover:bg-accent max-md:min-h-11", t.id === active.id ? "border-foreground text-foreground" : "border-transparent text-muted-foreground")} onClick={() => pickTab(t.id)} onKeyDown={onTabKey}>{t.label}</button>)}
			</div>
			{active.render()}
		</div>
		</PageViewer>
		</PromptBlocksContext.Provider>
	);
}

export function WolvesView(props: { machines: KeyMachine[]; catalog: PickerModel[]; reach?: ConsoleReach; call: Fetcher }) {
	// The open wolf lives in the path (/pack/wolves/<hostId>/<name>/<tab>), so reload, links and Back restore it. An old ?wolf=<h>/<n>&wolfTab=<t> link is redirected there.
	const router = useRouter();
	const pathname = usePathname();
	const search = useSearchParams()?.toString() ?? "";
	const sel = parseWolfPath(pathname);
	useEffect(() => {
		if (sel) return;
		const to = wolfRedirect(pathname, search);
		if (to) router.replace(to);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [pathname, search]);
	const setSel = (next: { hostId: string; name: string }) => router.push(wolfPath(next.hostId, next.name));
	const groups = groupWolves(props.machines);
	const m = sel ? props.machines.find((x) => x.hostId === sel.hostId) : undefined;
	const w = sel ? m?.wolves?.find((x) => x.name === sel.name) : undefined;
	if (sel && m && w) return <WolfDetail key={`${sel.hostId}/${sel.name}`} machine={m} wolf={w} machines={props.machines} catalog={props.catalog} reach={props.reach} call={props.call} />;
	if (sel) return <p className="text-xs text-muted-foreground" data-testid="wolf-not-found">Wolf not found: {sel.name} on {sel.hostId}. <a href="/pack/wolves" className="underline" onClick={(e) => (e.preventDefault(), router.push("/pack/wolves"))}>All wolves</a></p>;
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
