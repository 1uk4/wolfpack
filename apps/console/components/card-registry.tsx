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
export type CardKind = "tool" | "object";

export interface CardEntry {
	Renderer: ComponentType<ArtifactPartProps>;
	/**
	 * The card draws its own input-streaming state (the question tools
	 * render nothing until answered — the dock owns the pending UI), so
	 * chat.tsx must not substitute the generic live card.
	 */
	ownsStreaming?: boolean;
}

const cards = new Map<string, CardEntry>();

const slot = (kind: CardKind, key: string) => `${kind}:${key}`;

export function registerCard(kind: CardKind, key: string, entry: CardEntry): void {
	cards.set(slot(kind, key), entry);
}

/** The registered card, or undefined — callers keep their own fallback. */
export function lookupCard(kind: CardKind, key: string): CardEntry | undefined {
	return cards.get(slot(kind, key));
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
	registerCard("tool", name, { Renderer: ToolCallCard });
}
