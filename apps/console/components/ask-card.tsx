"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { MessageResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import { draftAnswers, draftComplete, initialDraft, multiInBounds, type CardDraft } from "@/src/core";
import type { CardField, CardFieldAnswer } from "@wolfpack/client";
import type { InteractionCardProps } from "@/components/card-registry";

/**
 * The inline interaction card of a wolf thread (the wolf asked a question): free-text, single-choice, multi-choice (checkboxes) and confirm (yes/no) fields.
 * Visuals follow the legacy question dock (question-dock.tsx) and its answered record (answered-card.tsx): a bordered
 * card, "Question" kicker, markdown question, option rows with an Other entry. Pending it is a form; answered it is the
 * static record. Defaults only pre-select; nothing submits until the operator presses Submit.
 */
export function AskCard({ card, answer, dismissed, heldAnswer, pending, submitting, onAnswer }: InteractionCardProps) {
	const [draft, setDraft] = useState<CardDraft>(() => initialDraft(card, heldAnswer));
	const set = (fieldId: string, a: CardFieldAnswer) => setDraft((d) => ({ ...d, [fieldId]: a }));
	const answered = answer !== undefined;
	const closed = answered || dismissed === true;
	const canSubmit = pending && !submitting && draftComplete(card, draft);

	return (
		<div
			className="rounded-xl border bg-card p-4 text-card-foreground"
			data-testid={dismissed ? "dismissed-card" : answered ? "answered-card" : "pending-card"}
			data-card-tool={card.tool}
		>
			<div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{card.title ?? "Question"}
				{dismissed && <span className="ml-2 rounded bg-muted px-1.5 py-0.5">skipped</span>}
				{!closed && !pending && <span className="ml-2 rounded bg-muted px-1.5 py-0.5">waiting</span>}
				{!closed && heldAnswer && <span data-testid="card-held" className="ml-2 rounded bg-muted px-1.5 py-0.5">answer saved · waiting for the other questions</span>}
			</div>
			{card.fields.map((f) => (
				<FieldView
					key={f.id}
					field={f}
					value={answered ? answer[f.id] : draft[f.id]}
					readOnly={closed || !pending || submitting}
					onChange={(a) => set(f.id, a)}
				/>
			))}
			{!closed && (
				<div className="mt-3 flex justify-end">
					<Button type="button" size="sm" disabled={!canSubmit} onClick={() => onAnswer(draftAnswers(card, draft))} data-testid="card-submit">
						{submitting ? "Sending…" : heldAnswer ? "Update answer" : "Submit"}
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
			{field.kind === "confirm" ? (
				<ConfirmView field={field} value={value} readOnly={readOnly} onChange={onChange} />
			) : field.kind === "multi" ? (
				<MultiView field={field} value={value} readOnly={readOnly} onChange={onChange} />
			) : field.kind === "free-text" ? (
				readOnly ? (
					<div className="lh-prose whitespace-pre-wrap" data-testid="card-answer-text">
						“{typeof value?.value === "string" ? value.value : ""}”
					</div>
				) : (
					<textarea
						data-testid="card-text"
						className="min-h-20 w-full resize-y rounded-lg border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
						value={typeof value?.value === "string" ? value.value : ""}
						onChange={(e) => onChange({ value: e.target.value })}
						placeholder="Your answer…"
					/>
				)
			) : (
				<div className="flex flex-col gap-1.5 text-sm" role="radiogroup">
					{field.options.map((o) => {
						const other = value !== undefined && "other" in value && value.other === true;
						const sel = !other && value?.value === o.value;
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
							otherText(value) !== undefined && (
								<div data-testid="answered-other" className="rounded-lg border border-primary bg-accent px-3 py-1.5">
									“{otherText(value)}”
								</div>
							)
						) : (
							<input
								data-testid="card-other"
								type="text"
								className={cn(
									"rounded-lg border bg-background px-3 py-1.5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
									isOther(value) && "border-primary bg-accent",
								)}
								placeholder="Other…"
								value={otherText(value) ?? ""}
								onChange={(e) => onChange({ value: e.target.value, other: true })}
							/>
						))}
				</div>
			)}
		</div>
	);
}

const otherText = (v: CardFieldAnswer | undefined): string | undefined => (v !== undefined && "other" in v && v.other === true ? String(v.value) : undefined);
const isOther = (v: CardFieldAnswer | undefined): boolean => otherText(v) !== undefined;

function MultiView({
	field,
	value,
	readOnly,
	onChange,
}: {
	field: Extract<CardField, { kind: "multi" }>;
	value: CardFieldAnswer | undefined;
	readOnly: boolean;
	onChange: (a: CardFieldAnswer) => void;
}) {
	const [typed, setTyped] = useState("");
	const picked = Array.isArray(value?.value) ? value.value : [];
	const custom = value && "other" in value && Array.isArray(value.other) ? value.other : [];
	const atMax = field.max !== undefined && picked.length >= field.max;
	const write = (next: string[], nextCustom: string[]) => onChange({ value: next, ...(nextCustom.length > 0 ? { other: nextCustom } : {}) });
	const toggle = (v: string) => (picked.includes(v) ? write(picked.filter((p) => p !== v), custom.filter((c) => c !== v)) : write([...picked, v], custom));
	const addCustom = () => {
		const t = typed.trim();
		if (!t || picked.includes(t) || atMax) return;
		write([...picked, t], [...custom, t]);
		setTyped("");
	};
	const rows = [
		...field.options.map((o) => ({ ...o, custom: false })),
		...custom.filter((c) => picked.includes(c)).map((c) => ({ label: c, value: c, description: undefined, custom: true })),
	];
	const hint = field.min !== undefined || field.max !== undefined ? `Pick ${field.min !== undefined && field.max !== undefined ? `${field.min}–${field.max}` : field.min !== undefined ? `at least ${field.min}` : `up to ${field.max}`}` : null;
	return (
		<div className="flex flex-col gap-1.5 text-sm" role="group" data-testid="card-multi">
			{rows.map((o) => {
				const sel = picked.includes(o.value);
				return (
					<button
						key={o.value}
						type="button"
						role="checkbox"
						aria-checked={sel}
						disabled={readOnly || (!sel && atMax)}
						data-testid="card-option"
						data-value={o.value}
						data-custom={o.custom ? "true" : undefined}
						onClick={() => toggle(o.value)}
						className={cn(
							"flex flex-col items-start rounded-lg border px-3 py-1.5 text-left transition-colors",
							sel ? "border-primary bg-accent" : "enabled:hover:bg-accent/50",
							readOnly && !sel && "text-muted-foreground",
						)}
					>
						<span className="flex items-center gap-2">
							<span aria-hidden>{sel ? "☑" : "☐"}</span>
							<MessageResponse>{o.label}</MessageResponse>
						</span>
						{o.description && <MessageResponse className="lh-prose block text-xs text-muted-foreground">{o.description}</MessageResponse>}
					</button>
				);
			})}
			{field.allowOther === true && !readOnly && (
				<div className="flex gap-2">
					<input
						data-testid="card-other"
						type="text"
						className="flex-1 rounded-lg border bg-background px-3 py-1.5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
						placeholder="Other…"
						value={typed}
						onChange={(e) => setTyped(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								addCustom();
							}
						}}
					/>
					<Button type="button" size="sm" variant="outline" data-testid="card-other-add" disabled={typed.trim() === "" || atMax} onClick={addCustom}>
						Add
					</Button>
				</div>
			)}
			{!readOnly && hint && (
				<div data-testid="card-multi-hint" className={cn("text-xs text-muted-foreground", !multiInBounds(field, picked.length) && "text-destructive")}>
					{hint}
				</div>
			)}
		</div>
	);
}

function ConfirmView({
	field,
	value,
	readOnly,
	onChange,
}: {
	field: Extract<CardField, { kind: "confirm" }>;
	value: CardFieldAnswer | undefined;
	readOnly: boolean;
	onChange: (a: CardFieldAnswer) => void;
}) {
	const picked = typeof value?.value === "boolean" ? value.value : undefined;
	const note = value && "note" in value ? value.note : undefined;
	const btn = (which: boolean, label: string, testid: string) => (
		<button
			type="button"
			role="radio"
			aria-checked={picked === which}
			disabled={readOnly}
			data-testid={testid}
			onClick={() => onChange({ value: which, ...(note ? { note } : {}) })}
			className={cn(
				"rounded-lg border px-4 py-1.5 text-sm transition-colors",
				picked === which ? "border-primary bg-accent" : "enabled:hover:bg-accent/50",
				readOnly && picked !== which && "text-muted-foreground",
			)}
		>
			{label}
		</button>
	);
	return (
		<div className="flex flex-wrap gap-2" role="radiogroup" data-testid="card-confirm-group">
			{btn(true, field.confirmLabel ?? "Yes", "card-confirm")}
			{btn(false, field.rejectLabel ?? "No", "card-reject")}
		</div>
	);
}
