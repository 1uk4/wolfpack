import type { ComponentType } from "react";
import type { CardAnswers, Card } from "@wolfpack/client";
import type { ArtifactPartProps, QuestionAnswerData } from "@/src/core";
import { AnsweredCard } from "@/components/answered-card";
import { AskCard } from "@/components/ask-card";
import { ToolCallCard } from "@/components/artifacts/tool-call-card";
import { DecisionCard } from "@/components/decision-card";
import { ChecklistCard } from "@/components/checklist-card";
import { PlanGraphCard } from "@/components/plan-graph-card";

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

/** Structured object cards (decision, graph, checklist). */
export interface ObjectCardEntry<P = ObjectCardProps> {
	kind: "object";
	Renderer: ComponentType<P>;
}

/**
 * What thread-chat hands an object card: the folded object (latest `data`,
 * `rev` = revisions so far + 1). `data` is the type's payload; each card
 * narrows it itself (see parseObjectData).
 */
export interface ObjectCardProps {
	objectId: string;
	type: string;
	rev: number;
	data: unknown;
}


/**
 * What a wolf thread hands an interaction card (a tool-raised protocol Card, ticket "ask card"): the card, the
 * operator's answer once given (read-only record), and the answer callback while pending.
 */
export interface InteractionCardProps {
	callId: string;
	card: Card;
	/** Set once answered: render the record, no controls. */
	answer?: CardAnswers;
	/** Superseded by a plain submit before it was answered: render as skipped, no controls. */
	dismissed?: boolean;
	/** The wolf holds this answer until the turn's sibling cards are answered; the card can still change it. */
	heldAnswer?: CardAnswers;
	/** The card waits for the operator (server-confirmed); false = raised but not yet confirmed pending. */
	pending: boolean;
	/** The answer is on its way to the server. */
	submitting: boolean;
	onAnswer(answers: CardAnswers): void;
}

/**
 * Interaction cards raised by tools (wolf threads), keyed by the card's `tool` name; "default" renders any card
 * whose tool has no renderer of its own.
 */
export interface InteractionCardEntry {
	kind: "card";
	Renderer: ComponentType<InteractionCardProps>;
}

export type CardEntry = ToolCardEntry | ObjectCardEntry | InteractionCardEntry;
export type CardKind = CardEntry["kind"];
type EntryOf<K extends CardKind> = Extract<CardEntry, { kind: K }>;

// Every registration lives in this file (or a barrel that imports it): bundlers
// drop unreferenced self-registering modules, so a card registered from its
// own module may silently never register.
const cards = new Map<string, CardEntry>();

const slot = (kind: CardKind, key: string) => `${kind}:${key}`;

export function registerCard<K extends CardKind>(kind: K, key: string, entry: Omit<EntryOf<K>, "kind">): void {
	const id = slot(kind, key);
	const existing = cards.get(id);
	if (existing?.Renderer === entry.Renderer) return;
	if (existing) {
		// Fast Refresh re-runs a registering module against the cached map with a
		// fresh Renderer identity: newest wins in dev, a real clash throws elsewhere.
		if (process.env.NODE_ENV !== "development") throw new Error(`card already registered: ${id}`);
		console.warn(`card re-registered: ${id}`);
	}
	cards.set(id, { ...entry, kind } as CardEntry);
}

/** @internal Test-only: drop a registration so tests don't leak into the global map. */
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

/** The renderer for a protocol card: its tool's own, else the default. */
export function lookupInteractionCard(tool: string): InteractionCardEntry | undefined {
	return lookupCard("card", tool) ?? lookupCard("card", "default");
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

// Wolf-thread interaction cards (protocol cards): the ask card renders any free-text / single card.
registerCard("card", "ask_user_question", { Renderer: AskCard });
registerCard("card", "default", { Renderer: AskCard });

// The filesystem set: one quiet expandable tool-call card each —
// collapsed one-liner (tool name + headline argument), full
// input/output on expand.
for (const name of ["read", "ls", "find", "grep"]) {
	registerCard("tool", name, { Renderer: ToolCallCard, threadRow: true });
}

// Structured objects, keyed by object type (src/core/objects.ts folds the
// object-upsert / history objects into one part per object).
registerCard("object", "decision", { Renderer: DecisionCard });
registerCard("object", "checklist", { Renderer: ChecklistCard });
registerCard("object", "graph", { Renderer: PlanGraphCard });
