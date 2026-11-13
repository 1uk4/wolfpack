"use client";

import { Button } from "@/components/ui/button";
import { InlineMarkdown } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import { multiInBounds } from "@/src/core";
import type { CardField } from "@wolfpack/client";
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
	const picked = Array.isArray(value?.value) ? value.value : [];
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
				return (
					<button
						key={o.value}
						type="button"
						aria-pressed={sel}
						disabled={readOnly || (!sel && atMax)}
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
						)}
					>
						<Indicator shape="check" on={sel} />
						<span className="flex min-w-0 flex-col items-start">
							<InlineMarkdown>{o.label}</InlineMarkdown>
							{o.description && <InlineMarkdown className="block text-xs text-muted-foreground">{o.description}</InlineMarkdown>}
						</span>
					</button>
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

