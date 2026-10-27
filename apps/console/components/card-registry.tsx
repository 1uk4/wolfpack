import type { ComponentType } from "react";
import type { ArtifactPartProps, QuestionAnswerData } from "@/src/core";
import { AnsweredCard } from "@/components/answered-card";
import { ToolCallCard } from "@/components/artifacts/tool-call-card";

/**
 * Card registry — the extension point for transcript cards.
 *
 * Keyed by (kind, key): "tool" cards key on the tool name ("read",
 * "quiz", …) and render a tool part; "object" cards are reserved for
 * structured object types (decision, graph, checklist) that register here
 * later with their own props — a second namespace, so an object type can
 * never shadow a tool name. chat.tsx and thread-chat.tsx look cards up
 * here — add renderers below, do NOT edit their dispatch.
 *
 * Typical tool shape: while the part is input-available render an activity
 * card (the chat view's jobs feed reads GET /api/jobs?chatId=…; on
 * completion call ChatActionsContext.syncFromServer()); when
 * output-available render the artifact itself from part.output. Job tools
 * register JobCard (components/artifacts/job-card.tsx) under their name.
 */
export interface ToolCardEntry {
	kind: "tool";
	Renderer: ComponentType<ArtifactPartProps>;
	/**
	 * The card draws its own input-streaming state (the question tools
	 * render nothing until answered — the dock owns the pending UI), so
	 * chat.tsx must not substitute the generic live card.
	 */
	ownsStreaming?: boolean;
	/** thread-chat expands a tool row into this card (the filesystem set only). */
	threadRow?: boolean;
}

/** Structured object cards (decision, graph, checklist) — props are theirs to define. */
export interface ObjectCardEntry<P = never> {
	kind: "object";
	Renderer: ComponentType<P>;
}

export type CardEntry = ToolCardEntry | ObjectCardEntry;
export type CardKind = CardEntry["kind"];
type EntryOf<K extends CardKind> = Extract<CardEntry, { kind: K }>;

// Every registration lives in this file (or a barrel it imports): bundlers
// drop unreferenced self-registering modules, so a card registered from its
// own module may silently never register.
const cards = new Map<string, CardEntry>();

const slot = (kind: CardKind, key: string) => `${kind}:${key}`;

export function registerCard<K extends CardKind>(kind: K, key: string, entry: Omit<EntryOf<K>, "kind">): void {
	const id = slot(kind, key);
	if (cards.has(id)) throw new Error(`card already registered: ${id}`);
	cards.set(id, { ...entry, kind } as CardEntry);
}

/** Test-only: drop a registration so tests don't leak into the global map. */
export function unregisterCard(kind: CardKind, key: string): void {
	cards.delete(slot(kind, key));
}

/** The registered card, or undefined — callers keep their own fallback. */
export function lookupCard<K extends CardKind>(kind: K, key: string): EntryOf<K> | undefined {
	const entry = cards.get(slot(kind, key));
	return entry?.kind === kind ? (entry as EntryOf<K>) : undefined;
}

export type ToolPartResolution =
	| { kind: "live" }
	| { kind: "card"; Renderer: ComponentType<ArtifactPartProps> }
	| { kind: "none" };

/**
 * What chat.tsx renders for a tool part: the live card while the call is
 * being written (unless the card draws its own streaming state), else the
 * registered card, else nothing.
 */
export function resolveToolPart(part: ArtifactPartProps["part"]): ToolPartResolution {
	if (!part.type.startsWith("tool-")) return { kind: "none" };
	const card = lookupCard("tool", part.type.slice("tool-".length));
	if (part.state === "input-streaming" && !card?.ownsStreaming) return { kind: "live" };
	return card ? { kind: "card", Renderer: card.Renderer } : { kind: "none" };
}

/**
 * Pending/streaming questions live in the dock, not the transcript;
 * answered ones render as graded records.
 */
function QuestionCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return null;
	return <AnsweredCard answer={part.output as QuestionAnswerData} input={part.input} />;
}

for (const name of ["quiz", "ask_user_question", "explain"]) {
	registerCard("tool", name, { Renderer: QuestionCard, ownsStreaming: true });
}

// The filesystem set: one quiet expandable tool-call card each —
// collapsed one-liner (tool name + headline argument), full
// input/output on expand.
for (const name of ["read", "ls", "find", "grep"]) {
	registerCard("tool", name, { Renderer: ToolCallCard, threadRow: true });
}
