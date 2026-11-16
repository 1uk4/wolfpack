/**
 * The Memory panel's Topics section: pure view helpers over a session-topic row (one row per topic).
 * Browser-safe, no IO.
 */
import type { MemoryTopicRow, MemoryTopics } from "@wolfpack/protocol";

export type { MemoryTopicRow, MemoryTopics };

export interface TopicChip {
	label: string;
	tone: "neutral" | "good" | "warn" | "muted";
	/** The full reason, shown as a tooltip. */
	title: string | undefined;
}

/** The state chip: just the state word, the reason as tooltip; none for an active topic. Held and parked are amber. */
export function topicChip(t: MemoryTopicRow): TopicChip | null {
	const title = t.reason || undefined;
	switch (t.state) {
		case "held": return { label: "held", tone: "warn", title };
		case "parked": return { label: "parked", tone: "warn", title };
		case "promoted": return { label: "promoted", tone: "good", title };
		case "retired": return { label: "retired", tone: "muted", title };
		default: return null;
	}
}

/** The row's optional second line: the state chip and the real sources; null when neither applies. */
export function topicSecondLine(t: MemoryTopicRow): { chip: TopicChip | null; sources: string[] } | null {
	const chip = topicChip(t);
	const sources = sourceLabels(t.sources);
	return chip || sources.length ? { chip, sources } : null;
}

export interface TopicFact {
	key: string;
	value: string;
	/** Set on the KB entries fact: each id links to /kb/entry/<id>. */
	entryIds?: string[];
}

/** The topic page's frontmatter block: state, reason, sources, updated, size, keep-local, and the KB entries it went into. */
export function topicFacts(t: MemoryTopicRow): TopicFact[] {
	const facts: TopicFact[] = [{ key: "state", value: t.state }];
	if (t.reason) facts.push({ key: "reason", value: t.reason });
	const sources = sourceLabels(t.sources);
	if (sources.length) facts.push({ key: "sources", value: sources.join(", ") });
	facts.push({ key: "updated", value: t.updated }, { key: "size", value: formatTopicSize(t.bytes) }, { key: "keep local", value: t.keepLocal ? "yes" : "no" });
	if (t.entryIds.length) facts.push({ key: "KB entries", value: t.entryIds.join(", "), entryIds: t.entryIds });
	return facts;
}

/** "N topics · X KB of Y KB". */
export function topicsHeader(m: MemoryTopics): string {
	const n = m.topics.length;
	const kb = (b: number) => `${(b / 1024).toFixed(1)} KB`;
	return `${n} ${n === 1 ? "topic" : "topics"} · ${kb(m.totalBytes)} of ${kb(m.capBytes)}`;
}

export function formatTopicSize(bytes: number): string {
	return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** Sources for display: the `thread:` prefix dropped; `legacy` (or none) is hidden. */
export function sourceLabels(sources: string[]): string[] {
	return sources.filter((s) => s !== "legacy").map((s) => s.replace(/^thread:/, ""));
}
