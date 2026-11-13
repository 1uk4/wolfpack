/**
 * The Memory panel's Topics section: pure view helpers over a session-topic row (one row per topic).
 * Browser-safe, no IO.
 */
import type { MemoryTopicRow, MemoryTopics } from "@wolfpack/protocol";

export type { MemoryTopicRow, MemoryTopics };

export interface TopicChip {
	label: string;
	tone: "neutral" | "good" | "warn" | "muted";
}

/** The state chip: keep-local wins over the state; held carries its reason; parked needs attention. */
export function topicChip(t: MemoryTopicRow): TopicChip {
	if (t.keepLocal) return { label: "keep-local", tone: "neutral" };
	switch (t.state) {
		case "held": return { label: t.reason ? `held: ${t.reason}` : "held", tone: "warn" };
		case "parked": return { label: "parked (needs attention)", tone: "warn" };
		case "promoted": return { label: "promoted", tone: "good" };
		case "retired": return { label: "retired", tone: "muted" };
		default: return { label: "active", tone: "neutral" };
	}
}

export function formatTopicSize(bytes: number): string {
	return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** Sources for display: the `thread:` prefix dropped; a topic with none is `legacy`. */
export function sourceLabels(sources: string[]): string[] {
	return sources.length ? sources.map((s) => s.replace(/^thread:/, "")) : ["legacy"];
}
