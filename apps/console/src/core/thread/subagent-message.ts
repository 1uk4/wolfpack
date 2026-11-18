/**
 * Messages wolfd delivers to a parent from its sub-agents arrive as user-role steers. pi-durable carries no message
 * metadata, so they are recognised by their text (the patterns of wolfd's subagents.ts and subagent-merge.ts) and the
 * child is resolved by name from the parent's children list. PURE.
 */
import type { ChildThread } from "./subagents.ts";

export type SubagentEvent = "result" | "question" | "merge" | "warning" | "error";

export interface SubagentOrigin {
	event: SubagentEvent;
	/** Child name as written in the message, when it names one. */
	name?: string;
	/** "7s", when the message says how long the child ran. */
	duration?: string;
	/** The text without the `[delivery id]` marker. */
	body: string;
	/** The first meaningful line of what the child said (the collapsed summary). */
	summary: string;
	/** A main-checkout warning rode along with a result. */
	warned?: boolean;
}

const MARKER = /\n*\[delivery [^\]\n]+\]\s*$/;
const WARNING = /^WARNING: the main checkout[^\n]*(\n|$)/;
const HEAD = /^Sub-agent "([^"\n]+)" (completed|asks|failed|was stopped|could not start)(?: after ([^\s(]+)| \(([^)\n]+)\))?/;
const MERGE = /^(Merged \S+ into |Not merged:|Merge conflict merging |Left as is:)/;

const EVENT: Record<string, SubagentEvent> = { completed: "result", asks: "question", failed: "error", "could not start": "error", "was stopped": "warning" };

const firstLine = (s: string): string => s.split("\n").map((l) => l.trim().replace(/^#+\s*/, "")).find((l) => l.length > 0) ?? "";

/** What a delivered message is, or undefined for anything else (an owner's own text). */
export function parseSubagentMessage(text: string): SubagentOrigin | undefined {
	if (!MARKER.test(text)) return undefined; // wolfd always appends the marker; owner text never has it
	let body = text.replace(MARKER, "");
	let warned = false;
	let rest = body;
	while (WARNING.test(rest)) {
		warned = true;
		rest = rest.replace(WARNING, "").replace(/^\n+/, "");
	}
	const merge = /^Sub-agent "([^"\n]+)" merge: ([\s\S]*)$/.exec(rest);
	if (merge) return { event: "merge", name: merge[1], body, summary: firstLine(merge[2]!), warned };
	const head = HEAD.exec(rest);
	if (head) {
		const after = rest.slice(head[0].length).replace(/^[^\n]*?\)?\.?\n+/, "");
		return { event: EVENT[head[2]!]!, name: head[1], duration: head[3] ?? head[4], body, summary: firstLine(head[2] === "completed" || head[2] === "asks" ? after : rest.slice(head[0].length)) || firstLine(rest), warned };
	}
	if (MERGE.test(rest)) {
		const name = /subagent_merge\(\{ name: "([^"]+)"/.exec(rest)?.[1] ?? /sub-agent "([^"]+)"/.exec(rest)?.[1];
		return { event: "merge", name, body, summary: firstLine(rest), warned };
	}
	if (warned && rest.trim() === "") return { event: "warning", body, summary: firstLine(body), warned };
	return undefined;
}

/** The child a delivery names, from the parent's children (by title = name). */
export const resolveChild = (origin: Pick<SubagentOrigin, "name">, children: readonly ChildThread[]): ChildThread | undefined =>
	origin.name === undefined ? undefined : children.find((c) => c.title === origin.name);

export const EVENT_LABEL: Record<SubagentEvent, string> = { result: "completed", question: "question", merge: "merge", warning: "warning", error: "failed" };
