"use client";

/**
 * The Prompts page (/prompts): one dependency graph per system (tabs), a reader panel for the clicked node. Editable prompts can be
 * saved (sent with the etag the page loaded, so a concurrent edit is a visible 409 conflict) or reset to the repo default.
 * Overrides live in the wolf's home; other wolves keep the default.
 */
import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { XIcon } from "lucide-react";
import { PromptGraphCanvas } from "@/components/prompt-graph-view";
import { PromptReader, ToolsReader } from "@/components/prompt-reader";
import { buildGraphs, EDITED_IN, parsePromptsUrl, PROMPT_TABS, promptsUrlSearch, type PromptsUrlState, HOST_LABEL, hostOf, hubId, standardUsers } from "../src/core/prompt-flows.ts";

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
	const [settings, setSettings] = useState<SettingsInfo | null>(null);
	const [soDraft, setSoDraft] = useState<string | null>(null);
	// The selected graph and node live in the URL, so a link or reload lands on the same view.
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

	const send = async (row: PromptRow, method: "PUT" | "DELETE"): Promise<boolean> => {
		const r = await fetch(`/api/wolves/${encodeURIComponent(wolf)}/prompts/${encodeURIComponent(row.id)}`, {
			method,
			headers: { "If-Match": row.etag, ...(method === "PUT" ? { "Content-Type": "application/json" } : {}) },
			...(method === "PUT" ? { body: JSON.stringify({ text: drafts[row.id] ?? row.text }) } : {}),
		});
		if (!r.ok) {
			const m = await readError(r);
			setErrors((e) => ({ ...e, [row.id]: m }));
			return false;
		}
		const next = (await r.json()) as PromptRow;
		setRows((rs) => rs.map((x) => (x.id === next.id ? next : x)));
		setDrafts((d) => {
			const { [row.id]: _gone, ...rest } = d;
			return rest;
		});
		setErrors((e) => ({ ...e, [row.id]: "" }));
		return true;
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

	const byId = new Map<string, PromptRow>([...rows.map((r) => [r.id, r] as [string, PromptRow]), ...(hubRows ?? []).map((r) => [hubId(r.id), r] as [string, PromptRow])]);

	/** The wolf.yaml-backed editor of the structured-output block (shared by the cards and the reader). */
	const structuredEditor = (row: PromptRow) => (
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
	);

	const graphs = buildGraphs(rows, hubRows);
	const activeGraph = graphs.find((g) => g.key === urlState.graph) ?? graphs[0]!;
	const activeNode = activeGraph.nodes.find((n) => n.id === urlState.node);
	/** The side panel: the clicked node's existing editor cards, next to the graph. A bottom-up full-screen overlay on a narrow screen. */
	const panelOpen = !!activeNode;
	const closeGraph = urlState.graph;
	// Escape closes the node panel and clears `node` from the URL.
	useEffect(() => {
		if (!panelOpen) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setUrl({ graph: closeGraph });
		};
		// Capture on the document: this runs before the Settings dialog's Escape handler, and claiming the event keeps
		// that handler (and the window chain) from also acting. The first Escape closes the reader, the next the dialog.
		const onKeyFirst = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopImmediatePropagation();
			onKey(e);
		};
		document.addEventListener("keydown", onKeyFirst, true);
		return () => document.removeEventListener("keydown", onKeyFirst, true);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [panelOpen, closeGraph, pathname]);
	const renderPanel = () => {
		if (!activeNode) return null;
		const panelRows = activeNode.ids.map((id) => byId.get(id)).filter((r): r is PromptRow => !!r);
		const close = () => setUrl({ graph: urlState.graph });
		const openNode = (id: string) => setUrl({ graph: urlState.graph, node: id });
		const isTools = activeNode.id.startsWith("tools:");
		const single = panelRows.length === 1 && !isTools;
		const closeButton = (
			<button type="button" className="inline-flex size-7 shrink-0 items-center justify-center rounded hover:bg-accent" aria-label="Close panel" onClick={close} data-testid="prompt-panel-close"><XIcon className="size-4" aria-hidden /></button>
		);
		const readerFor = (r: PromptRow, withClose: boolean, withTitle: boolean) => (
			<PromptReader
				key={`${activeNode.id}-${r.id}`}
				row={r}
				host={hostOf(r.id)}
				hideHeader={!withTitle}
				closeButton={withClose ? closeButton : undefined}
				editedIn={EDITED_IN[r.id] ? { id: EDITED_IN[r.id]!, label: byId.get(EDITED_IN[r.id]!)?.label ?? EDITED_IN[r.id]! } : undefined}
				onOpenNode={openNode}
				usedBy={r.id.startsWith("standard.") ? standardUsers(rows, r.id) : undefined}
				draft={drafts[r.id]}
				setDraft={(t) => setDrafts((d) => ({ ...d, [r.id]: t }))}
				clearDraft={() => setDrafts((d) => { const { [r.id]: _gone, ...rest } = d; return rest; })}
				error={errors[r.id] ?? ""}
				onSave={() => send(r, "PUT")}
				onReset={() => send(r, "DELETE")}
				structuredEditor={r.id === STRUCTURED ? structuredEditor(r) : undefined}
			/>
		);
		return (
			<aside className="fixed inset-0 z-40 flex min-w-0 flex-col gap-4 overflow-y-auto bg-background p-4 md:static md:z-auto md:h-[60vh] md:w-1/2 md:shrink-0 md:rounded-md md:border" data-testid="prompt-panel" aria-label={`${activeNode.title} prompt`}>
				{single ? (
					readerFor(panelRows[0]!, true, true)
				) : (
					<>
						<header className="flex items-center gap-2">
							<h2 className="min-w-0 flex-1 text-sm font-semibold">{activeNode.title}</h2>
							{activeNode.host !== "wolf" && <span className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground">{HOST_LABEL[activeNode.host]}</span>}
							{closeButton}
						</header>
						{!panelRows.length && activeNode.host === "hub" && activeNode.ids.length > 0 && <p className="text-xs text-muted-foreground" data-testid="flow-hub-missing">The text loads when a hub is connected.</p>}
						{!panelRows.length && !(activeNode.host === "hub" && activeNode.ids.length > 0) && <p className="text-xs text-muted-foreground">{activeNode.hubMissing ? "Hub not connected." : "No prompt runs at this step."}</p>}
						{isTools ? <ToolsReader rows={panelRows} /> : panelRows.map((r) => readerFor(r, false, true))}
					</>
				)}
			</aside>
		);
	};
	/** A click: a linked node opens its tab; Other opens its first unplaced prompt; anything else opens its reader. */
	const onSelect = (id: string) => {
		const n = activeGraph.nodes.find((x) => x.id === id);
		if (n?.link) return setUrl({ graph: n.link });
		const target = id === "other" ? activeGraph.edges.find((e) => e.from === "other")?.to ?? id : id;
		setUrl({ graph: activeGraph.key, node: target });
	};

	return (
		<div className="flex min-w-0 flex-col gap-4 p-3 sm:p-5" data-testid="prompts-page">
			<label className="flex items-center gap-2 text-sm">
				Wolf
				<select className="rounded border bg-background px-2 py-1" value={wolf} onChange={(e) => setWolf(e.target.value)} data-testid="prompts-wolf">
					{wolves.map((w) => (
						<option key={w} value={w}>{w}</option>
					))}
				</select>
			</label>
			<div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Prompt graphs" data-testid="prompts-tabs">
				{PROMPT_TABS.map((t) => (
					<button key={t.key} role="tab" aria-selected={urlState.graph === t.key} className={`rounded border px-3 py-1 text-sm ${urlState.graph === t.key ? "bg-accent" : ""}`} onClick={() => setUrl({ graph: t.key })} data-testid={`prompts-tab-${t.key}`}>{t.title}</button>
				))}
			</div>
			{loadError && <p className="text-sm text-destructive" role="alert">{loadError}</p>}
			{activeGraph.key === "sweep" && hubRows === null && <p className="text-xs text-muted-foreground" data-testid="flow-hub-missing-line">Hub not connected{hubNote ? ` (${hubNote})` : ""}.</p>}
			<div className="flex min-w-0 flex-col gap-3 md:flex-row" data-testid={`prompt-graph-${activeGraph.key}`}>
				<div className="h-[60vh] min-h-[320px] min-w-0 flex-1 rounded-md border">
					<PromptGraphCanvas graph={activeGraph} selected={activeNode?.id ?? null} onSelect={onSelect} />
				</div>
				{renderPanel()}
			</div>
		</div>
	);
}
