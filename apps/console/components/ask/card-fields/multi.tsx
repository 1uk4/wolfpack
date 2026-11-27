"use client";

import { Button } from "@/components/ui/button";
import { InlineMarkdown } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import { multiInBounds } from "@/src/core";
import type { CardField } from "@wolfpack/client";
import { isSameOriginPath } from "@wolfpack/protocol";
import { openGraduationLink, useOpenView } from "@/components/viewer/viewer-context";
import { HourglassIcon } from "lucide-react";
import { THREAD_RUNNING_LABEL, graduationOptionWolf, useRunningItems } from "@/components/work/thread-running";
import { CardTextInput, Indicator, OPTION_ROW } from "./shared";
import type { FieldRendererProps } from "./types";

export function MultiRenderer({
	field,
	value,
	readOnly,
	onChange,
	labelledBy,
	typed,
	onType,
	onAddCustom: onAdd,
	error,
	dictation,
}: FieldRendererProps<Extract<CardField, { kind: "multi" }>>) {
	const openView = useOpenView();
	const picked = Array.isArray(value?.value) ? value.value : [];
	// A graduation card (its options link to the graduation view of a work item): an item whose feature thread still runs shows but cannot be picked.
	const gradWolf = field.options.map((o) => graduationOptionWolf("href" in o ? (o.href as string | undefined) : undefined)).find((w) => w !== undefined);
	const running = useRunningItems(gradWolf);
	const custom = value && "other" in value && Array.isArray(value.other) ? value.other : [];
	const atMax = field.max !== undefined && picked.length >= field.max;
	const write = (next: string[], nextCustom: string[]) => onChange({ value: next, ...(nextCustom.length > 0 ? { other: nextCustom } : {}) });
	const toggle = (v: string) => (picked.includes(v) ? write(picked.filter((p) => p !== v), custom.filter((c) => c !== v)) : write([...picked, v], custom));
	const addCustom = () => onAdd?.();
	const rows = [
		...field.options.map((o) => ({ ...o, custom: false })),
		...custom.filter((c) => picked.includes(c)).map((c) => ({ label: c, value: c, description: undefined, custom: true })),
	];
	const min = Math.max(field.min ?? 0, field.optional ? 0 : 1);
	const hint = min > 0 || field.max !== undefined ? `Pick ${min > 0 && field.max !== undefined ? `${min}–${field.max}` : min > 0 ? `at least ${min}` : `up to ${field.max}`}` : null;
	return (
		<div className="flex flex-col gap-1.5 text-sm" role="group" aria-labelledby={labelledBy} data-testid="card-multi">
			{rows.map((o) => {
				const sel = picked.includes(o.value);
				const threadRunning = !!gradWolf && !readOnly && !o.custom && running.has(o.value);
				const href = "href" in o ? o.href : undefined;
				// A link is never nested in the option button (it would be invalid HTML and tick the box): it sits beside it. Same-origin paths only.
				const link = isSameOriginPath(href) ? href : undefined;
				const row = (
					<button
						key={o.value}
						type="button"
						aria-pressed={sel}
						disabled={readOnly || threadRunning || (!sel && atMax)}
						aria-label={threadRunning ? `${o.label}: ${THREAD_RUNNING_LABEL}` : undefined}
						title={threadRunning ? THREAD_RUNNING_LABEL : undefined}
						data-testid="card-option"
						data-value={o.value}
						data-custom={o.custom ? "true" : undefined}
						onClick={() => toggle(o.value)}
						className={cn(
							OPTION_ROW,
							sel ? "border-primary bg-accent" : "enabled:hover:bg-accent/50",
							readOnly && !sel && "text-muted-foreground",
							// at max: the unpicked rows stay visible but clearly unavailable
							!readOnly && !sel && atMax && "cursor-not-allowed opacity-50",
							threadRunning && "cursor-not-allowed opacity-60",
						)}
					>
						{threadRunning ? <HourglassIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden /> : <Indicator shape="check" on={sel} />}
						<span className="flex min-w-0 flex-col items-start">
							<InlineMarkdown>{o.label}</InlineMarkdown>
							{o.description && <InlineMarkdown className="block text-xs text-muted-foreground">{o.description}</InlineMarkdown>}
						</span>
					</button>
				);
				if (!link) return row;
				return (
					<div key={o.value} className="flex items-start gap-2">
						{row}
						<a href={link} target="_blank" rel="noopener" data-testid="card-option-link" onClick={(e) => (e.stopPropagation(), openGraduationLink(e, openView, link))} className="shrink-0 self-center whitespace-nowrap text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
							more details
						</a>
					</div>
				);
			})}
			{field.allowOther === true && !readOnly && (
				<div className="flex gap-2">
					<CardTextInput testId="card-other" className="px-3 py-1.5" placeholder="Other…" value={typed} onChange={onType} onEnter={addCustom} {...dictation} />
					<Button type="button" size="sm" variant="outline" data-testid="card-other-add" disabled={typed.trim() === "" || error !== undefined} onClick={addCustom}>
						Add
					</Button>
				</div>
			)}
			{!readOnly && error && (
				<div data-testid="card-other-error" className="text-xs text-destructive">
					{error}
				</div>
			)}
			{!readOnly && hint && (
				<div data-testid="card-multi-hint" className={cn("text-xs text-muted-foreground", picked.length > 0 && !multiInBounds(field, picked.length) && "text-destructive")}>
					{hint}
				</div>
			)}
		</div>
	);
}

