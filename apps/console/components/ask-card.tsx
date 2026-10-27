"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { MessageResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import { draftAnswers, draftComplete, initialDraft, type CardDraft } from "@/src/core";
import type { CardField, CardFieldAnswer } from "@wolfpack/client";
import type { InteractionCardProps } from "@/components/card-registry";

/**
 * The inline interaction card of a wolf thread (the wolf asked a question): free-text and single-choice fields.
 * Visuals follow the legacy question dock (question-dock.tsx) and its answered record (answered-card.tsx): a bordered
 * card, "Question" kicker, markdown question, option rows with an Other entry. Pending it is a form; answered it is the
 * static record. Defaults only pre-select; nothing submits until the operator presses Submit.
 */
export function AskCard({ card, answer, pending, submitting, onAnswer }: InteractionCardProps) {
	const [draft, setDraft] = useState<CardDraft>(() => initialDraft(card));
	const set = (fieldId: string, a: CardFieldAnswer) => setDraft((d) => ({ ...d, [fieldId]: a }));
	const answered = answer !== undefined;
	const canSubmit = pending && !submitting && draftComplete(card, draft);

	return (
		<div
			className="rounded-xl border bg-card p-4 text-card-foreground"
			data-testid={answered ? "answered-card" : "pending-card"}
			data-card-tool={card.tool}
		>
			<div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{card.title ?? "Question"}
				{!answered && !pending && <span className="ml-2 rounded bg-muted px-1.5 py-0.5">waiting</span>}
			</div>
			{card.fields.map((f) => (
				<FieldView
					key={f.id}
					field={f}
					value={answered ? answer[f.id] : draft[f.id]}
					readOnly={answered || !pending || submitting}
					onChange={(a) => set(f.id, a)}
				/>
			))}
			{!answered && (
				<div className="mt-3 flex justify-end">
					<Button type="button" size="sm" disabled={!canSubmit} onClick={() => onAnswer(draftAnswers(card, draft))} data-testid="card-submit">
						{submitting ? "Sending…" : "Submit"}
					</Button>
				</div>
			)}
		</div>
	);
}

function FieldView({
	field,
	value,
	readOnly,
	onChange,
}: {
	field: CardField;
	value: CardFieldAnswer | undefined;
	readOnly: boolean;
	onChange: (a: CardFieldAnswer) => void;
}) {
	return (
		<div className="mb-2 last:mb-0" data-field={field.id}>
			<div className="mb-2 font-medium">
				<MessageResponse>{field.label}</MessageResponse>
			</div>
			{field.description && (
				<div className="mb-3 text-sm text-muted-foreground">
					<MessageResponse>{field.description}</MessageResponse>
				</div>
			)}
			{field.kind === "free-text" ? (
				readOnly ? (
					<div className="lh-prose whitespace-pre-wrap" data-testid="card-answer-text">
						“{value?.value ?? ""}”
					</div>
				) : (
					<textarea
						data-testid="card-text"
						className="min-h-20 w-full resize-y rounded-lg border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
						value={value?.value ?? ""}
						onChange={(e) => onChange({ value: e.target.value })}
						placeholder="Your answer…"
					/>
				)
			) : (
				<div className="flex flex-col gap-1.5 text-sm" role="radiogroup">
					{field.options.map((o) => {
						const sel = value?.other !== true && value?.value === o.value;
						return (
							<button
								key={o.value}
								type="button"
								role="radio"
								aria-checked={sel}
								disabled={readOnly}
								data-testid="card-option"
								data-value={o.value}
								onClick={() => onChange({ value: o.value })}
								className={cn(
									"flex flex-col items-start rounded-lg border px-3 py-1.5 text-left transition-colors",
									sel ? "border-primary bg-accent" : "enabled:hover:bg-accent/50",
									readOnly && !sel && "text-muted-foreground",
								)}
							>
								<MessageResponse>{o.label}</MessageResponse>
								{o.description && <MessageResponse className="lh-prose block text-xs text-muted-foreground">{o.description}</MessageResponse>}
							</button>
						);
					})}
					{field.allowOther !== false &&
						(readOnly ? (
							value?.other && (
								<div data-testid="answered-other" className="rounded-lg border border-primary bg-accent px-3 py-1.5">
									“{value.value}”
								</div>
							)
						) : (
							<input
								data-testid="card-other"
								type="text"
								className={cn(
									"rounded-lg border bg-background px-3 py-1.5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
									value?.other && "border-primary bg-accent",
								)}
								placeholder="Other…"
								value={value?.other ? value.value : ""}
								onChange={(e) => onChange({ value: e.target.value, other: true })}
							/>
						))}
				</div>
			)}
		</div>
	);
}
