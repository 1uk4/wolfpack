"use client";

/**
 * The Prompts page (/prompts): for the selected wolf, every registered prompt with its effective text and a default/overridden badge.
 * Editable prompts can be saved (sent with the etag the page loaded, so a concurrent edit is a visible 409 conflict) or reset to the
 * repo default. Overrides live in the wolf's home; other wolves keep the default.
 */
import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { XIcon } from "lucide-react";
import { SidebarToggle } from "@/components/sidebar";
import { PromptGraphCanvas } from "@/components/prompt-graph-view";
import { buildFlows, buildGraphs, buildTree, chipGroup, EDITED_IN, parsePromptsUrl, PROMPT_TABS, promptsUrlSearch, type PromptsUrlState, HOST_LABEL, hostOf, hubId, standardUsers, treeCardIds, visibleRows, type FlowStep, type TreeNode } from "../src/core/prompt-flows.ts";

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
	/** Identity only: a pristine original exists, so Restore original works. */
	hasOriginal?: boolean;
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

type HubPrompt = { id: string; group: string; label: string; text: string };
const toHubRows = (ps: HubPrompt[]): PromptRow[] =>
	ps.map((p) => ({
		...p,
		editable: false,
		source: "default" as const,
		etag: "",
		kind: "pipeline" as const,
		file: "packages/engine/src/prompts.ts (hubd GET /v1/settings)",
		user: "hubd KB sweep (librarian)",
		scope: "hub" as const,
	}));

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
	/** Open cards and steps by key; a key not listed follows the filter (open while a chip is chosen). */
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});
	const [nodeOpen, setNodeOpen] = useState<Record<string, boolean>>({});
	const [view, setView] = useState<"tree" | "flows">("tree");
	// The selected graph (or "list") and node live in the URL, so a link or reload lands on the same view.
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const urlState = parsePromptsUrl(searchParams.toString());
	const setUrl = (next: PromptsUrlState) => router.replace(`${pathname}${promptsUrlSearch(next)}`, { scroll: false });
	/** The hub's KB-sweep prompts for flow B step 4; null when the hub is not connected (hubNote says why). */
	const [hubRows, setHubRows] = useState<PromptRow[] | null>(null);
	const [hubNote, setHubNote] = useState("");

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
			const j = (await o.json()) as { hub?: { ok: boolean; error?: string; settings?: { prompts: HubPrompt[] } } };
			if (!j.hub?.ok) return setLoadError(`The hub did not answer: ${j.hub?.error ?? "unknown error"}`);
			setRows(toHubRows(j.hub.settings?.prompts ?? []));
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
		void fetch("/api/settings/overview")
			.then(async (o) => {
				const h = o.ok ? ((await o.json()) as { hub?: { ok: boolean; error?: string; settings?: { prompts: HubPrompt[] } } }).hub : undefined;
				if (h?.ok) {
					setHubRows(toHubRows(h.settings?.prompts ?? []));
					setHubNote("");
				} else {
					setHubRows(null);
					setHubNote(h?.error ?? "no hub answered");
				}
			})
			.catch(() => {
				setHubRows(null);
				setHubNote("no hub answered");
			});
		const sr = await fetch(`/api/wolves/${encodeURIComponent(wolf)}/settings`).catch(() => null);
		if (sr?.ok) {
			const v = (await sr.json()) as { etag: string; config?: { prompts?: { structuredOutput?: string | false } }; restartNeeded?: boolean };
			setSettings({ etag: v.etag, value: v.config?.prompts?.structuredOutput, restartNeeded: !!v.restartNeeded });
		}
	}, [wolf]);
	useEffect(() => {
		void load();
	}, [load]);
	// A chip opens what it shows (a key not set follows the filter) and scrolls to the first match.
	useEffect(() => {
		setExpanded({});
		if (!group) return;
		const t = requestAnimationFrame(() => document.querySelector("[data-leaf], [data-step]")?.scrollIntoView({ block: "start", behavior: "smooth" }));
		return () => cancelAnimationFrame(t);
	}, [group, view]);

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

	const isHub = wolf === HUB;
	const graphMode = !isHub && urlState.graph !== "list";
	const listed = isHub ? rows : visibleRows(rows);
	const chipOf = (r: PromptRow) => (isHub ? r.group : chipGroup(r));
	const groups = [...new Set(listed.map(chipOf))];
	const shown = group ? listed.filter((r) => chipOf(r) === group) : listed;
	const shownIds = new Set(shown.map((r) => r.id));
	const byId = new Map<string, PromptRow>([...rows.map((r) => [r.id, r] as [string, PromptRow]), ...(hubRows ?? []).map((r) => [hubId(r.id), r] as [string, PromptRow])]);

	/** One prompt's card: the same editor in every view. `ctx` adds the view-specific lines (edited-in link, used-by). */
	const card = (row: PromptRow, ctx: { editedIn?: string; usedBy?: string[] } = {}, key = row.id) => {
				const draft = drafts[row.id] ?? row.text;
				return (
					<section key={key} className="flex min-w-0 flex-col gap-2 rounded-md border p-3" data-testid={`prompt-${row.id}`}>
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
						{ctx.editedIn && (
							<p className="text-xs" data-testid={`prompt-edited-in-${row.id}`}>Edited in: <a className="underline" href={`#leaf-${ctx.editedIn}`} onClick={(e) => { e.preventDefault(); reveal(ctx.editedIn!); }}>{byId.get(ctx.editedIn)?.label ?? ctx.editedIn}</a></p>
						)}
						{row.id === STRUCTURED && <p className="text-xs" data-testid="prompt-edited-in-structured">Edited in: the box below (saved to wolf.yaml).</p>}
						{!row.editable && row.kind === "system-block" && row.id !== STRUCTURED && !ctx.editedIn && <p className="text-xs text-muted-foreground" data-testid={`prompt-edited-in-${row.id}`}>Edited in: nowhere; read-only.</p>}
						{ctx.usedBy && <p className="text-xs text-muted-foreground" data-testid={`prompt-used-by-${row.id}`}>Used by: {ctx.usedBy.length ? ctx.usedBy.join(", ") : "no profile names it"}</p>}
						{row.editable && row.applies && <p className="text-xs text-muted-foreground" data-testid={`prompt-applies-${row.id}`}>An edit applies {row.applies}. {row.id === "identity" ? "Restore original puts back the identity as it was before its first edit here; every edit is also kept as a backup (last 10). This is the wolf's own agent/AGENTS.md (there is no repo default)." : "The previous version is kept as a backup (last 10)."}</p>}
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
								<button className="rounded border px-3 py-1 text-sm disabled:opacity-50" disabled={row.id === "identity" ? row.hasOriginal !== true : row.source === "default"} title={row.id === "identity" && row.hasOriginal !== true ? "No original to restore: the identity has not been edited here yet" : undefined} onClick={() => void send(row, "DELETE")} data-testid={`prompt-reset-${row.id}`}>{row.id === "identity" ? "Restore original" : "Reset to default"}</button>
								<button className="rounded border px-3 py-1 text-sm" onClick={() => void load()}>Reload</button>
							</div>
						)}
					</section>
				);
	};

	const isOpen = (k: string) => expanded[k] ?? !!group;
	const toggle = (k: string) => setExpanded((e) => ({ ...e, [k]: !isOpen(k) }));
	/** Open a card and bring it into view (the "Edited in" links and Expand all use it). */
	const reveal = (id: string) => {
		if (graphMode) return setUrl({ graph: urlState.graph, node: id });
		setExpanded((e) => ({ ...e, [id]: true }));
		requestAnimationFrame(() => document.getElementById(`leaf-${id}`)?.scrollIntoView({ block: "start", behavior: "smooth" }));
	};
	const keep = (id: string) => shownIds.has(id);

	const badge = "rounded border px-1.5 py-0.5 text-xs text-muted-foreground";
	/** The collapsed one-line header of a leaf or a step: chevron, title, badges, source in muted text. */
	const rowButton = (k: string, title: string, badges: React.ReactNode, source: string | undefined, testid: string) => (
		<button type="button" aria-expanded={isOpen(k)} onClick={() => toggle(k)} className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-2 py-1.5 text-left hover:bg-accent/50" data-testid={testid}>
			<span aria-hidden className="w-3 text-xs text-muted-foreground">{isOpen(k) ? "▾" : "▸"}</span>
			<span className="min-w-0 text-sm font-medium">{title}</span>
			{badges}
			{source && <span className="min-w-0 break-all text-xs text-muted-foreground sm:ml-auto sm:max-w-[45%] sm:text-right">{source}</span>}
		</button>
	);
	const rowBadges = (row: PromptRow, host = hostOf(row.id)) => (
		<>
			<span className={badge}>{HOST_LABEL[host]}</span>
			<span className={badge}>{row.editable ? "editable" : "read-only"}</span>
			{row.source === "override" && <span className="rounded bg-accent px-1.5 py-0.5 text-xs">overridden</span>}
		</>
	);
	/** A tree leaf: ONE compact row; clicking expands the full card inline. */
	const leaf = (row: PromptRow, ctx: { editedIn?: string; usedBy?: string[] } = {}) => (
		<div key={row.id} id={`leaf-${row.id}`} className="flex min-w-0 flex-col gap-2 scroll-mt-4" data-leaf data-testid={`leaf-${row.id}`}>
			{rowButton(row.id, row.label, rowBadges(row), row.file, `leaf-toggle-${row.id}`)}
			{isOpen(row.id) && card(row, ctx, row.id)}
		</div>
	);

	const renderTreeNode = (node: TreeNode) => {
		const items = node.items.filter((i) => keep(i.id) || (i.editedIn && keep(i.editedIn)));
		const subs = (node.subagents ?? []).filter((sa) => keep(sa.id) || sa.cards.some(keep));
		if (!items.length && !subs.length) return null;
		return (
			<details key={node.key} open={nodeOpen[node.key] ?? (!node.collapsed || !!group)} onToggle={(e) => { const o = (e.currentTarget as HTMLDetailsElement).open; setNodeOpen((n) => (n[node.key] === o ? n : { ...n, [node.key]: o })); }} className="flex flex-col gap-2" data-testid={`tree-node-${node.key}`}>
				<summary className="cursor-pointer text-sm font-semibold">{node.title}</summary>
				<div className="mt-2 flex min-w-0 flex-col gap-2 border-l pl-2 sm:pl-5">
					{node.note && <p className="text-xs text-muted-foreground">{node.note}</p>}
					{items.map((i) => {
						const row = byId.get(i.id);
						if (!row) return null;
						const target = i.editedIn ? byId.get(i.editedIn) : undefined;
						return (
							<div key={i.id} className="flex min-w-0 flex-col gap-2" data-testid={`tree-item-${i.id}`}>
								{keep(i.id) && leaf(row, i.editedIn ? { editedIn: i.editedIn } : {})}
								{target && keep(i.editedIn!) && <div className="ml-2 min-w-0 border-l pl-2 sm:ml-5 sm:pl-3">{leaf(target)}</div>}
							</div>
						);
					})}
					{subs.map((sa) => {
						const row = byId.get(sa.id);
						if (!row) return null;
						return (
							<div key={sa.id} className="flex min-w-0 flex-col gap-2" data-testid={`tree-subagent-${sa.id}`}>
								{keep(sa.id) && leaf(row)}
								{sa.reads.length > 0 && <p className="ml-2 text-xs text-muted-foreground sm:ml-5">Reads standards: {sa.reads.map((r) => r.replace(/^standard\./, "")).join(", ")}</p>}
								{sa.cards.filter(keep).map((sid) => (
									<div key={sid} className="ml-2 min-w-0 border-l pl-2 sm:ml-5 sm:pl-3">{leaf(byId.get(sid)!, { usedBy: standardUsers(rows, sid) })}</div>
								))}
							</div>
						);
					})}
				</div>
			</details>
		);
	};
	const tree = buildTree(rows);
	const graphs = buildGraphs(rows, hubRows);
	const activeGraph = graphMode ? graphs.find((g) => g.key === urlState.graph) : undefined;
	const activeNode = activeGraph?.nodes.find((n) => n.id === urlState.node);
	/** The side panel: the clicked node's existing editor cards, next to the graph. A bottom-up full-screen overlay on a narrow screen. */
	const renderPanel = () => {
		if (!activeGraph || !activeNode) return null;
		const many = activeNode.ids.length > 3;
		const panelRows = activeNode.ids.map((id) => byId.get(id)).filter((r): r is PromptRow => !!r);
		const ctxOf = (r: PromptRow) => (r.id.startsWith("standard.") ? { usedBy: standardUsers(rows, r.id) } : EDITED_IN[r.id] ? { editedIn: EDITED_IN[r.id]! } : {});
		return (
			<aside className="fixed inset-0 z-40 flex min-w-0 flex-col gap-3 overflow-y-auto bg-background p-3 md:static md:z-auto md:max-h-[70vh] md:w-[28rem] md:shrink-0 md:rounded-md md:border" data-testid="prompt-panel" aria-label={`${activeNode.title} prompt`}>
				<header className="flex items-start gap-2">
					<div className="min-w-0 flex-1">
						<h2 className="text-sm font-semibold">{activeNode.title}</h2>
						<p className="mt-1 flex flex-wrap gap-1.5">
							<span className={badge}>{HOST_LABEL[activeNode.host]}</span>
							<span className={badge}>{activeNode.marker}</span>
						</p>
					</div>
					<button type="button" className="inline-flex size-8 shrink-0 items-center justify-center rounded border hover:bg-accent" aria-label="Close panel" onClick={() => setUrl({ graph: urlState.graph })} data-testid="prompt-panel-close"><XIcon className="size-4" aria-hidden /></button>
				</header>
				{activeNode.note && <p className="text-xs text-muted-foreground">{activeNode.note}</p>}
				{activeNode.hubMissing && <p className="text-xs text-muted-foreground" data-testid="flow-hub-missing">Hub not connected, so the sweep prompts cannot be shown{hubNote ? ` (${hubNote})` : ""}. This step runs on the hub with the prompts hubd reports.</p>}
				{!panelRows.length && !activeNode.hubMissing && <p className="text-xs text-muted-foreground">No prompt runs at this step.</p>}
				{panelRows.map((r) =>
					many ? (
						<details key={r.id} className="rounded-md border">
							<summary className="cursor-pointer px-2 py-1.5 text-sm">{r.label} <span className="text-xs text-muted-foreground">{r.editable ? "editable" : "read-only"}</span></summary>
							<div className="p-2">{card(r, ctxOf(r))}</div>
						</details>
					) : (
						card(r, ctxOf(r), `${activeNode.id}-${r.id}`)
					),
				)}
			</aside>
		);
	};
	const renderTree = () => (
		<div className="flex flex-col gap-3" data-testid="prompts-tree">
			<h2 className="text-sm font-semibold">Main wolf (orchestrator)</h2>
			{tree.map((node) => renderTreeNode(node))}
		</div>
	);

	const stepKey = (fk: string, n: number) => `step:${fk}:${n}`;
	const renderStep = (fk: string, st: FlowStep) => {
		const stepRows = st.ids.map((id) => ({ id, row: byId.get(id) })).filter((x): x is { id: string; row: PromptRow } => !!x.row);
		const visible = stepRows.filter((x) => (x.id.startsWith("hub:") ? !group || chipOf(x.row) === group : keep(x.id)));
		if (group && st.ids.length && !visible.length) return null;
		const k = stepKey(fk, st.n);
		const fileList = [...new Set(stepRows.map((x) => x.row.file).filter((f): f is string => !!f))];
		const files = fileList.length > 2 ? `${fileList[0]} and ${fileList.length - 1} more` : fileList.join(", ");
		const badges = (
			<>
				<span className={badge} data-testid={`flow-host-${fk}-${st.n}`}>{HOST_LABEL[st.host]}</span>
				{stepRows.length > 0 && <span className={badge}>{stepRows.every((x) => x.row.editable) ? "editable" : stepRows.some((x) => x.row.editable) ? "partly editable" : "read-only"}</span>}
				{st.hubMissing && <span className="rounded bg-accent px-1.5 py-0.5 text-xs">hub not connected</span>}
			</>
		);
		return (
			<li key={st.n} className="flex min-w-0 flex-col gap-2" data-step data-testid={`flow-step-${fk}-${st.n}`}>
				{st.crossing && <p className="rounded bg-accent px-2 py-1 text-xs font-medium" data-testid="flow-crossing">{st.crossing}</p>}
				{rowButton(k, `${st.n}. ${st.title}`, badges, files || undefined, `step-toggle-${fk}-${st.n}`)}
				{st.hubMissing && (
					<p className="text-xs text-muted-foreground" data-testid="flow-hub-missing">Hub not connected, so the sweep prompts cannot be shown{hubNote ? ` (${hubNote})` : ""}. This step runs on the hub with the prompts hubd reports.</p>
				)}
				{isOpen(k) && (
					<div className="ml-2 flex min-w-0 flex-col gap-2 border-l pl-2 sm:ml-5 sm:pl-3">
						{st.note && <p className="text-xs text-muted-foreground">{st.note}</p>}
						{visible.map((x) => card(x.row, x.id.startsWith("standard.") ? { usedBy: standardUsers(rows, x.id) } : {}, `${st.n}-${x.id}`))}
					</div>
				)}
			</li>
		);
	};
	const flows = buildFlows(rows, hubRows);
	const renderFlows = () => (
		<div className="flex flex-col gap-6" data-testid="prompts-flows">
			{flows.map((f) => {
				const steps = f.steps.map((st) => renderStep(f.key, st)).filter(Boolean);
				if (group && !steps.length) return null;
				return (
					<section key={f.key} className="flex flex-col gap-2" data-testid={`flow-${f.key}`}>
						<h2 className="text-sm font-semibold">{f.title}</h2>
						<ol className="flex flex-col gap-2">{steps}</ol>
					</section>
				);
			})}
		</div>
	);
	/** Expand all / Collapse all for the view shown. */
	const allKeys = (): string[] => (view === "tree" ? treeCardIds(tree).filter(keep) : flows.flatMap((f) => f.steps.map((st) => stepKey(f.key, st.n))));
	const expandAll = () => {
		setExpanded(Object.fromEntries(allKeys().map((k) => [k, true])));
		if (view === "tree") setNodeOpen(Object.fromEntries(tree.map((n) => [n.key, true])));
	};
	const collapseAll = () => {
		setExpanded(Object.fromEntries(allKeys().map((k) => [k, false])));
	};

	return (
		<main className={`mx-auto flex ${graphMode ? "max-w-7xl" : "max-w-4xl"} flex-col gap-4 p-3 sm:p-6`} data-testid="prompts-page">
			<header className="flex items-center gap-2">
				<SidebarToggle />
				<h1 className="text-lg font-semibold">Prompts</h1>
			</header>
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
			{!isHub && (
				<div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Prompt graphs" data-testid="prompts-tabs">
					{PROMPT_TABS.map((t) => (
						<button key={t.key} role="tab" aria-selected={urlState.graph === t.key} className={`rounded border px-3 py-1 text-sm ${urlState.graph === t.key ? "bg-accent" : ""}`} onClick={() => setUrl({ graph: t.key })} data-testid={`prompts-tab-${t.key}`}>{t.title}</button>
					))}
				</div>
			)}
			{!isHub && !graphMode && (
				<div className="flex gap-1.5" role="tablist" aria-label="Prompts view" data-testid="prompts-views">
					{(["tree", "flows"] as const).map((v) => (
						<button key={v} role="tab" aria-selected={view === v} className={`rounded border px-3 py-1 text-sm ${view === v ? "bg-accent" : ""}`} onClick={() => setView(v)} data-testid={`prompts-view-${v}`}>{v === "tree" ? "Wolf tree" : "Flows"}</button>
					))}
				</div>
			)}
			{!isHub && !graphMode && (
				<div className="flex gap-1.5" data-testid="prompts-expand-controls">
					<button className="rounded border px-2 py-0.5 text-xs" onClick={expandAll} data-testid="prompts-expand-all">Expand all</button>
					<button className="rounded border px-2 py-0.5 text-xs" onClick={collapseAll} data-testid="prompts-collapse-all">Collapse all</button>
				</div>
			)}
			{groups.length > 1 && !graphMode && (
				<nav className="flex flex-wrap gap-1.5" aria-label="Prompt groups" data-testid="prompts-groups">
					{["", ...groups].map((g) => (
						<button key={g || "all"} className={`rounded border px-2 py-0.5 text-xs ${group === g ? "bg-accent" : ""}`} onClick={() => setGroup(g)} data-testid={`prompts-group-${g || "all"}`}>
							{g || "All"} ({g ? rows.filter((r) => r.group === g).length : rows.length})
						</button>
					))}
				</nav>
			)}
			{loadError && <p className="text-sm text-destructive" role="alert">{loadError}</p>}
			{activeGraph ? (
				<div className="flex min-w-0 flex-col gap-3 md:flex-row" data-testid={`prompt-graph-${activeGraph.key}`}>
					<div className="h-[60vh] min-h-[320px] min-w-0 flex-1 rounded-md border">
						<PromptGraphCanvas graph={activeGraph} selected={activeNode?.id ?? null} onSelect={(id) => setUrl({ graph: activeGraph.key, node: id })} />
					</div>
					{renderPanel()}
				</div>
			) : isHub ? shown.map((row) => card(row)) : view === "tree" ? renderTree() : renderFlows()}
		</main>
	);
}
