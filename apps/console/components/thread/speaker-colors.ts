import type { LedgerEntry } from "@wolfpack/client";

export type Speaker = LedgerEntry["from"];

/**
 * One colour per speaker, shared by the subagent modal's ledger and transcript and the parent chat's SubagentMessage
 * (whose messages come from a child). Literal class strings so Tailwind sees them.
 */
export const SPEAKER: Record<Speaker, { label: string; bar: string; tint: string; text: string }> = {
	parent: { label: "Parent", bar: "border-l-violet-500", tint: "bg-violet-500/10", text: "text-violet-600 dark:text-violet-400" },
	child: { label: "Child", bar: "border-l-sky-500", tint: "bg-sky-500/10", text: "text-sky-600 dark:text-sky-400" },
	owner: { label: "You", bar: "border-l-emerald-500", tint: "bg-emerald-500/10", text: "text-emerald-600 dark:text-emerald-400" },
	system: { label: "System", bar: "border-l-muted-foreground/50", tint: "bg-muted/40", text: "text-muted-foreground" },
};

/** The classes of a highlighted block for `who`: accent bar plus faint tint. */
export const speakerBlock = (who: Speaker): string => `border-l-[3px] ${SPEAKER[who].bar} ${SPEAKER[who].tint}`;
