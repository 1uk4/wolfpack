/**
 * The Prompts page layout as data: where each prompt id sits in the Wolf tree and in the Flows. The page is only a renderer of
 * this. Ids the layout does not know fall into an "Other" node, so a new prompt never vanishes. Pure: no DOM, no fetch.
 */

export interface FlowRow {
	id: string;
	group: string;
	label: string;
	editable: boolean;
	text: string;
}

/** Defined in the registry but never called by any engine step: hidden from both views and the filter. */
export const HIDDEN_IDS: ReadonlySet<string> = new Set(["pipeline.breakdown-suggestion"]);

export const visibleRows = <T extends { id: string }>(rows: T[]): T[] => rows.filter((r) => !HIDDEN_IDS.has(r.id));

/** The order composeProjectContext (packages/harness/src/wolfd/context.ts) adds the system-prompt blocks. A block it did not add for this wolf is simply absent. */
export const SYSTEM_ORDER = ["system.header", "system.identity", "system.orchestrator", "system.agents-md", "system.claude-md", "system.skills", "system.structured-output", "system.brief"] as const;

/** The editable entry behind a composed block. (system.structured-output is edited on its own settings-backed card, which is the block's own card.) */
export const EDITED_IN: Readonly<Record<string, string>> = { "system.identity": "identity", "system.orchestrator": "orchestrator-rules" };

/** The background-job prompts the layout knows; any other pipeline.* id falls into Other. */
const BACKGROUND_IDS = new Set([
	"pipeline.observer", "pipeline.observer-user", "pipeline.consolidate", "pipeline.consolidate-user", "pipeline.pack-digest",
	"pipeline.crawl-observer", "pipeline.crawl-observer-user", "pipeline.crawl-consolidate", "pipeline.crawl-consolidate-user", "pipeline.crawl-journey", "pipeline.crawl-journey-user",
	"pipeline.distill", "pipeline.distill-graduation", "pipeline.distill-graduation-standing", "pipeline.work-record", "pipeline.task-summary",
]);

const STAGES = ["idea", "plan", "feasibility", "approved", "in_build", "shipped", "live"];

/** The chip a row filters under: the duplicate Orchestrator / Identity / System prompt groups are one. */
export function chipGroup(row: Pick<FlowRow, "group">): string {
	return row.group === "Orchestrator" || row.group === "Identity" ? "System prompt" : row.group;
}

/** The `standards:` names in a profile's frontmatter, in order. */
export function standardsOf(profileText: string): string[] {
	const fm = profileText.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
	const line = fm.split("\n").find((l) => /^standards:/.test(l));
	return line ? line.slice("standards:".length).split(",").map((s) => s.trim()).filter(Boolean) : [];
}

/** The profiles (by short name) that read a standard, computed from their frontmatter. */
export function standardUsers(rows: FlowRow[], standardId: string): string[] {
	const name = standardId.replace(/^standard\./, "");
	return rows.filter((r) => r.id.startsWith("agent.") && standardsOf(r.text).includes(name)).map((r) => r.id.replace(/^agent\./, ""));
}

export interface TreeItem {
	id: string;
	/** The editable row this composed block is edited in (rendered under the block). */
	editedIn?: string;
}
export interface Subagent {
	id: string;
	/** Standard row ids the profile's frontmatter names (those that exist). */
	reads: string[];
	/** The standards whose card is rendered under this profile (the first profile that reads it). */
	cards: string[];
}
export interface TreeNode {
	key: string;
	title: string;
	note?: string;
	collapsed?: boolean;
	items: TreeItem[];
	subagents?: Subagent[];
}

export function buildTree(allRows: FlowRow[]): TreeNode[] {
	const rows = visibleRows(allRows);
	const ids = new Set(rows.map((r) => r.id));
	const placed = new Set<string>();
	const take = (id: string): boolean => (ids.has(id) && !placed.has(id) ? (placed.add(id), true) : false);
	const takeAll = (pred: (id: string) => boolean): TreeItem[] => rows.filter((r) => pred(r.id) && take(r.id)).map((r) => ({ id: r.id }));

	// System prompt: the composed blocks in order; an editable source with no composed block (no identity file) still gets its place.
	const system: TreeItem[] = [];
	for (const b of SYSTEM_ORDER) {
		const src = EDITED_IN[b];
		if (take(b)) system.push({ id: b, ...(src && take(src) ? { editedIn: src } : {}) });
		else if (src && take(src)) system.push({ id: src });
	}
	for (const r of rows) if (r.id.startsWith("system.") && take(r.id)) system.push({ id: r.id });

	const tools = takeAll((id) => id.startsWith("tool."));
	const work: TreeItem[] = [];
	for (const id of ["pipeline.active-work-header", "pipeline.success-criteria-line", ...STAGES.map((s) => `pipeline.stage-context.${s}`)]) if (take(id)) work.push({ id });
	work.push(...takeAll((id) => id.startsWith("pipeline.stage-context.")));

	const standardRows = rows.filter((r) => r.id.startsWith("standard."));
	const subagents: Subagent[] = rows
		.filter((r) => r.id.startsWith("agent."))
		.map((p) => {
			const reads = standardsOf(p.text).map((n) => `standard.${n}`).filter((id) => standardRows.some((s) => s.id === id));
			take(p.id);
			return { id: p.id, reads, cards: reads.filter(take) };
		});
	const unread = takeAll((id) => id.startsWith("standard."));

	const compaction = takeAll((id) => id.startsWith("compaction."));
	const background = takeAll((id) => BACKGROUND_IDS.has(id));
	const creation = takeAll((id) => ["new-work", "grilling", "to-spec", "to-tickets"].includes(id));
	const other = rows.filter((r) => !placed.has(r.id)).map((r) => ({ id: r.id }));

	const nodes: TreeNode[] = [
		{ key: "system", title: "System prompt, built at start-up", note: "In the order wolfd composes it. Optional blocks (project AGENTS.md / CLAUDE.md, skills) appear only when the wolf has them.", items: system },
		{ key: "tools", title: `Tools offered (${tools.length})`, collapsed: true, items: tools },
		{ key: "work", title: "Injected when bound to a work item", note: "Active-work header, then success criteria, then the stage context.", items: work },
		{ key: "creation", title: "Work-creation skill (new-work)", note: "Read by the main wolf when it creates work.", items: creation },
		{ key: "subagents", title: "Subagents", note: "Each profile with the standards its frontmatter names. Standards no profile names are listed last.", items: unread, subagents },
		{ key: "compaction", title: "Thread compaction (pi-durable)", items: compaction },
		{ key: "background", title: "Background jobs (run by the wolf, outside the model's turn)", note: "Memory, promotion and crawl prompts; see the Flows view for their order.", collapsed: true, items: background },
	];
	if (other.length) nodes.push({ key: "other", title: "Other", items: other });
	return nodes.filter((n) => n.key === "other" || n.items.length > 0 || (n.subagents?.length ?? 0) > 0);
}

/** Every id that renders a card in the tree (for the exactly-once guarantee). */
export function treeCardIds(tree: TreeNode[]): string[] {
	return tree.flatMap((n) => [...n.items.flatMap((i) => (i.editedIn ? [i.id, i.editedIn] : [i.id])), ...(n.subagents ?? []).flatMap((s) => [s.id, ...s.cards])]);
}

export type Host = "wolf" | "hub" | "wolfd-pi-durable";
export interface FlowStep {
	n: number;
	title: string;
	host: Host;
	/** Prompt ids shown together (system prompt, then user template). Hub rows are `hub:<id>`. */
	ids: string[];
	note?: string;
	/** Shown above the step where the flow leaves the wolf's host. */
	crossing?: string;
	/** The step needs the hub and it is not connected. */
	hubMissing?: boolean;
}
export interface Flow {
	key: string;
	title: string;
	steps: FlowStep[];
}

export const HOST_LABEL: Record<Host, string> = { wolf: "wolf", hub: "hub", "wolfd-pi-durable": "wolfd (pi-durable)" };

/** The host a prompt id runs on (for a tree leaf; flow steps carry their own). */
export const hostOf = (id: string): Host => (id.startsWith("hub:") ? "hub" : id.startsWith("compaction.") ? "wolfd-pi-durable" : "wolf");

/** Hub rows (hubd GET /v1/settings) as prefixed ids so they cannot collide with a wolf's. */
export const hubId = (id: string): string => `hub:${id}`;

/** `hubRows` null: the hub is not connected. */
export function buildFlows(allRows: FlowRow[], hubRows: FlowRow[] | null): Flow[] {
	const rows = visibleRows(allRows);
	const have = new Set(rows.map((r) => r.id));
	const used = new Set<string>();
	const ids = (...want: string[]): string[] => want.filter((id) => have.has(id)).map((id) => (used.add(id), id));
	let n = 0;
	const step = (s: Omit<FlowStep, "n">): FlowStep => ({ n: ++n, ...s });
	const flow = (key: string, title: string, steps: FlowStep[]): Flow => {
		n = 0;
		return { key, title, steps };
	};
	const startsWith = (p: string) => rows.filter((r) => r.id.startsWith(p)).map((r) => r.id);

	// Each flow's steps are built after n is reset, so numbering restarts per flow.
	n = 0;
	const work = flow("work", "A. Work creation, stages and graduation", [
		step({ title: "new-work: route and run the pipeline", host: "wolf", ids: ids("new-work") }),
		step({ title: "grilling", host: "wolf", ids: ids("grilling") }),
		step({ title: "to-spec", host: "wolf", ids: ids("to-spec") }),
		step({ title: "to-tickets", host: "wolf", ids: ids("to-tickets") }),
		step({ title: "Bound to a work item: header and success criteria", host: "wolf", ids: ids("pipeline.active-work-header", "pipeline.success-criteria-line"), note: "Injected into the system prompt of every thread bound to an item, before its stage context." }),
		...STAGES.map((s) => step({ title: `Stage: ${s}`, host: "wolf", ids: ids(`pipeline.stage-context.${s}`), note: "Its stage context is injected into the prompt of a thread bound to an item at this stage." })),
		step({ title: "On completion: task summary", host: "wolf", ids: ids("pipeline.task-summary") }),
		step({ title: "On completion: work record", host: "wolf", ids: ids("pipeline.work-record") }),
		step({ title: "On graduation: distill (finished item, then standing feature)", host: "wolf", ids: ids("pipeline.distill-graduation", "pipeline.distill-graduation-standing"), note: "Writes a contribution to the KB inbox." }),
	]);
	n = 0;
	const convo = flow("conversation", "B. Conversation to KB", [
		step({ title: "Observer", host: "wolf", ids: ids("pipeline.observer", "pipeline.observer-user") }),
		step({ title: "Consolidation", host: "wolf", ids: ids("pipeline.consolidate", "pipeline.consolidate-user", "pipeline.pack-digest") }),
		step({ title: "Promote (distill) to the KB inbox", host: "wolf", ids: ids("pipeline.distill"), note: "Ends on the wolf: the contribution lands in the KB inbox, which syncs to the hub." }),
		step({ title: "Hub curation (KB sweep)", host: "hub", ids: (hubRows ?? []).map((r) => hubId(r.id)), crossing: "The flow crosses from the wolf's host to the hub here.", ...(hubRows === null ? { hubMissing: true } : {}) }),
	]);
	n = 0;
	const crawl = flow("crawl", "C. Crawl", [
		step({ title: "Crawl observer", host: "wolf", ids: ids("pipeline.crawl-observer", "pipeline.crawl-observer-user") }),
		step({ title: "Crawl consolidation", host: "wolf", ids: ids("pipeline.crawl-consolidate", "pipeline.crawl-consolidate-user") }),
		step({ title: "Crawl journey", host: "wolf", ids: ids("pipeline.crawl-journey", "pipeline.crawl-journey-user") }),
		step({ title: "Release", host: "wolf", ids: [], note: "Publishes the crawl's topics to the KB inbox. No prompt runs here. It then joins flow B at step 4 (hub curation)." }),
	]);
	n = 0;
	const compaction = flow("compaction", "D. Thread lifecycle: compaction", [
		step({ title: "Automatic compaction (context nearly full)", host: "wolfd-pi-durable", ids: ids("compaction.pi-durable-system", "compaction.pi-durable-instructions") }),
		step({ title: "Manual compaction (the owner asks)", host: "wolfd-pi-durable", ids: [], note: "Runs the same two prompts as the automatic step." }),
	]);
	n = 0;
	const standing = flow("standing", "E. Loaded in every flow", [
		step({ title: "System prompt blocks", host: "wolf", ids: ids(...startsWith("system."), "identity", "orchestrator-rules") }),
		step({ title: "Tools offered", host: "wolf", ids: ids(...startsWith("tool.")) }),
		step({ title: "Subagent profiles and standards", host: "wolf", ids: ids(...startsWith("agent."), ...startsWith("standard.")), note: "Read at every subagent spawn." }),
	]);
	const flows = [work, convo, crawl, compaction, standing];
	const other = rows.filter((r) => !used.has(r.id)).map((r) => r.id);
	if (other.length) flows.push({ key: "other", title: "Other", steps: [{ n: 1, title: "Not placed in a flow", host: "wolf", ids: other }] });
	return flows;
}

// ---- One dependency graph per flow (the Prompts page draws these; the List tab keeps the rows). ----

export type GraphKey = "system" | "subagents" | "work" | "kb" | "crawl" | "compaction";
export type PromptsTab = GraphKey | "list";
/** The tabs, in order: the five graphs, then the flat list. */
export const PROMPT_TABS: ReadonlyArray<{ key: PromptsTab; title: string }> = [
	{ key: "system", title: "System prompt" },
	{ key: "subagents", title: "Subagents" },
	{ key: "work", title: "Work creation" },
	{ key: "kb", title: "Conversation to KB" },
	{ key: "crawl", title: "Crawl" },
	{ key: "compaction", title: "Compaction" },
	{ key: "list", title: "List" },
];

export type NodeMarker = "editable" | "partly editable" | "read-only" | "no prompt";
export interface GraphNodeDef {
	/** Unique within its graph; the prompt id for a one-prompt node, so `?node=pipeline.observer` works. */
	id: string;
	title: string;
	host: Host;
	marker: NodeMarker;
	/** The prompt ids the node's side panel opens (hub rows are `hub:<id>`); empty for a step that runs no prompt. */
	ids: string[];
	/** A small second line on the node; only where it says something the title and markers do not. */
	sub?: string;
	note?: string;
	hubMissing?: boolean;
}
/** `from` feeds `to`: it is read, or runs, before it (left to right in the drawing). */
export interface GraphEdgeDef {
	from: string;
	to: string;
}
export interface PromptGraph {
	key: GraphKey;
	title: string;
	nodes: GraphNodeDef[];
	edges: GraphEdgeDef[];
}

/** `hubRows` null: the hub is not connected. */
export function buildGraphs(allRows: FlowRow[], hubRows: FlowRow[] | null): PromptGraph[] {
	const rows = visibleRows(allRows);
	const byId = new Map<string, FlowRow>(rows.map((r) => [r.id, r]));
	for (const h of hubRows ?? []) byId.set(hubId(h.id), { ...h, editable: false });
	const markerOf = (ids: string[]): NodeMarker => {
		const es = ids.map((i) => byId.get(i)?.editable).filter((e): e is boolean => e !== undefined);
		return !es.length ? "no prompt" : es.every(Boolean) ? "editable" : es.some(Boolean) ? "partly editable" : "read-only";
	};
	const leaf = (id: string, extra: Partial<GraphNodeDef> = {}): GraphNodeDef => ({ id, title: byId.get(id)?.label ?? id, host: hostOf(id), marker: markerOf([id]), ids: [id], ...extra });
	const chain = (ids: string[]): GraphEdgeDef[] => ids.slice(1).map((to, i) => ({ from: ids[i]!, to }));

	// System prompt: the blocks in composition order, the editable sources feeding their blocks, and the collapsed Tools node.
	const tree = buildTree(allRows);
	const sysNodes: GraphNodeDef[] = [];
	const sysEdges: GraphEdgeDef[] = [];
	const blocks: string[] = [];
	for (const it of tree.find((n) => n.key === "system")?.items ?? []) {
		sysNodes.push(leaf(it.id));
		blocks.push(it.id);
		if (it.editedIn) {
			sysNodes.push(leaf(it.editedIn));
			sysEdges.push({ from: it.editedIn, to: it.id });
		}
	}
	sysEdges.push(...chain(blocks));
	const toolIds = tree.find((n) => n.key === "tools")?.items.map((i) => i.id) ?? [];
	if (toolIds.length) sysNodes.push({ id: "tools", title: `Tools (${toolIds.length})`, host: "wolf", marker: markerOf(toolIds), ids: toolIds });
	const system: PromptGraph = { key: "system", title: "System prompt", nodes: sysNodes, edges: sysEdges };

	// Subagents: the main wolf to each profile to the standards its frontmatter names; a standard no profile names stands apart.
	const subTree = tree.find((n) => n.key === "subagents");
	const subNodes: GraphNodeDef[] = [{ id: "main-wolf", title: "Main wolf", host: "wolf", marker: "no prompt", ids: [], note: "Spawns the helper profiles; each reads the standards its frontmatter names." }];
	const subEdges: GraphEdgeDef[] = [];
	const read = new Set<string>();
	for (const sa of subTree?.subagents ?? []) {
		subNodes.push(leaf(sa.id));
		subEdges.push({ from: "main-wolf", to: sa.id }, ...sa.reads.map((to) => ({ from: sa.id, to })));
		for (const r of sa.reads) read.add(r);
	}
	subNodes.push(...[...read].map((id) => leaf(id)));
	subNodes.push(...(subTree?.items ?? []).map((i) => leaf(i.id, { sub: "not read by any profile" })));
	const subagents: PromptGraph = { key: "subagents", title: "Subagents", nodes: subNodes, edges: subEdges };

	// The flows A-D become chains of their steps.
	const flows = buildFlows(allRows, hubRows);
	const flowOf = (k: string) => flows.find((f) => f.key === k)!;
	const stepNode = (fk: string, st: FlowStep): GraphNodeDef => {
		const hub = st.host === "hub";
		const id = hub ? "hub-curation" : (st.ids[0] ?? `step:${fk}:${st.n}`);
		return {
			id, title: st.title, host: st.host, marker: markerOf(st.ids), ids: st.ids,
			...(hub ? { note: st.crossing } : st.note ? { note: st.note } : {}),
			...(st.hubMissing ? { hubMissing: true } : {}),
		};
	};
	const chained = (key: GraphKey, title: string, fk: string): PromptGraph => {
		const nodes = flowOf(fk).steps.map((st) => stepNode(fk, st));
		return { key, title, nodes, edges: chain(nodes.map((n) => n.id)) };
	};
	const work = chained("work", "Work creation", "work");
	const kb = chained("kb", "Conversation to KB", "conversation");
	const crawl = chained("crawl", "Crawl", "crawl");
	const hubNode = kb.nodes.find((n) => n.id === "hub-curation");
	if (hubNode) {
		crawl.nodes.push({ ...hubNode, sub: "joins Conversation to KB" });
		crawl.edges.push({ from: crawl.nodes[crawl.nodes.length - 2]!.id, to: "hub-curation" });
	}

	const compNodes: GraphNodeDef[] = [
		{ id: "step:compaction:auto", title: "Automatic compaction", host: "wolfd-pi-durable", marker: "no prompt", ids: [] },
		{ id: "step:compaction:manual", title: "Manual compaction", host: "wolfd-pi-durable", marker: "no prompt", ids: [], note: "Runs the same two prompts as the automatic step." },
		...["compaction.pi-durable-system", "compaction.pi-durable-instructions"].filter((id) => byId.has(id)).map((id) => leaf(id)),
	];
	const compPrompts = compNodes.slice(2).map((n) => n.id);
	const compaction: PromptGraph = {
		key: "compaction", title: "Compaction", nodes: compNodes,
		edges: [...(compPrompts[0] ? [{ from: "step:compaction:auto", to: compPrompts[0] }, { from: "step:compaction:manual", to: compPrompts[0] }] : []), ...chain(compPrompts)],
	};

	// Anything no graph places lands in an Other node on the main graph, so a new prompt never vanishes.
	const graphs = [system, subagents, work, kb, crawl, compaction];
	const placed = new Set(graphs.flatMap((g) => g.nodes.flatMap((n) => n.ids)));
	const otherIds = rows.filter((r) => !placed.has(r.id)).map((r) => r.id);
	if (otherIds.length) system.nodes.push({ id: "other", title: `Other (${otherIds.length})`, host: "wolf", marker: markerOf(otherIds), ids: otherIds, sub: "not placed in a flow" });
	return graphs;
}

/** The layout component reads an edge as "from depends on to": prerequisites sit left. A feed a→b is that edge reversed. */
export const dependencyEdges = (edges: GraphEdgeDef[]): GraphEdgeDef[] => edges.map((e) => ({ from: e.to, to: e.from }));

export interface PromptsUrlState {
	graph: PromptsTab;
	node?: string;
}
/** `?graph=kb&node=pipeline.observer`; an unknown graph (and an old `main`) is the System prompt tab, which adds nothing to the URL. */
export function parsePromptsUrl(search: string): PromptsUrlState {
	const p = new URLSearchParams(search);
	const g = p.get("graph");
	const graph = PROMPT_TABS.find((t) => t.key === (g === "main" ? "system" : g))?.key ?? "system";
	const node = p.get("node");
	return { graph, ...(node ? { node } : {}) };
}
export function promptsUrlSearch(s: PromptsUrlState): string {
	const p = new URLSearchParams();
	if (s.graph !== "system") p.set("graph", s.graph);
	if (s.node) p.set("node", s.node);
	const q = p.toString();
	return q ? `?${q}` : "";
}
