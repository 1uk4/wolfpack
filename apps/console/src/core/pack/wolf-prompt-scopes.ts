/**
 * Scope chips for the wolf detail's prompt graph (work-wolfpack-eE5FKDy). View only: nothing here edits a prompt.
 * Memory includes the whole memory prompt chain: observe, consolidate, promote, work memory, work context and the hub KB sweep. Pure.
 */
export type PromptScope = "all" | "wolf" | "memory" | "workspace" | "system";

export const PROMPT_SCOPES: ReadonlyArray<{ key: PromptScope; label: string }> = [
	{ key: "all", label: "All" },
	{ key: "wolf", label: "Wolf" },
	{ key: "memory", label: "Memory" },
	{ key: "workspace", label: "Workspace" },
	{ key: "system", label: "System" },
];

/**
 * The prompt-flows graph (settings/prompt-flows.ts graph key) each scope shows. A graph is a picture of ONE flow, so each scope has its own:
 * all and system show the system prompt as wolfd builds it at start-up; wolf shows what is added per request (sections, injected messages,
 * nudges, guards); memory shows the memory prompt chain; workspace shows the subagent profiles and their standards.
 * The list under the graph is still filtered by the scope itself.
 */
export const SCOPE_GRAPH: Readonly<Record<PromptScope, "system" | "request" | "memory" | "subagents">> = {
	all: "system",
	wolf: "request",
	memory: "memory",
	workspace: "subagents",
	system: "system",
};

const MEMORY = /^(hub:|pipeline\.(observer|consolidate|distill|work-|task-summary|pack-digest|crawl-|breakdown|stage-context|active-work-header|success-criteria-line))/;

/** The scope a prompt id belongs to (never "all"). */
export function promptScope(id: string): Exclude<PromptScope, "all"> {
	if (MEMORY.test(id)) return "memory";
	if (id.startsWith("system.") || id.startsWith("compaction.") || id.startsWith("tool.")) return "system";
	if (id.startsWith("agent.") || id.startsWith("standard.")) return "workspace";
	return "wolf";
}

export const filterByScope = <T extends { id: string }>(rows: T[], scope: PromptScope): T[] => (scope === "all" ? rows : rows.filter((r) => promptScope(r.id) === scope));

/** Where a prompt comes from, in words. */
export function sourceText(r: { source: "default" | "override"; file?: string }): string {
	const where = r.file ? ` (${r.file})` : "";
	return `${r.source === "override" ? "Edited for this wolf" : "Built in"}${where}`;
}

/** Size of a prompt's text: characters and a rough token count (4 characters a token). */
export function sizeText(text: string): string {
	if (!text) return "empty";
	return `${text.length.toLocaleString("en-US")} characters, about ${Math.round(text.length / 4).toLocaleString("en-US")} tokens`;
}
