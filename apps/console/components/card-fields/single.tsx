"use client";

import { InlineMarkdown } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import type { CardField } from "@wolfpack/client";
import { CardTextInput, Indicator, OPTION_ROW, isOther, otherText } from "./shared";
import type { FieldRendererProps } from "./types";

export function SingleRenderer({ field, value, readOnly, onChange, onClear, labelledBy, compact, dictation }: FieldRendererProps<Extract<CardField, { kind: "single" }>>) {
	return (
		<div className="flex flex-col gap-1.5 text-sm" role="group" aria-labelledby={labelledBy}>
			{field.options.map((o) => {
				const other = value !== undefined && "other" in value && value.other === true;
				const sel = !other && value?.value === o.value;
				return (
					<button
						key={o.value}
						type="button"
						aria-pressed={sel}
						disabled={readOnly}
						data-testid="card-option"
						data-value={o.value}
						onClick={() => (sel && field.optional ? onClear() : onChange({ value: o.value }))}
						className={cn(OPTION_ROW, compact && "px-2 py-1", sel ? "border-primary bg-accent" : "enabled:hover:bg-accent/50", readOnly && !sel && "text-muted-foreground")}
					>
						<Indicator shape="radio" on={sel} />
						<span className="flex min-w-0 flex-col items-start">
							<InlineMarkdown>{o.label}</InlineMarkdown>
							{o.description && <InlineMarkdown className="block text-xs text-muted-foreground">{o.description}</InlineMarkdown>}
						</span>
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
					<CardTextInput
						testId="card-other"
						className={cn("px-3 py-1.5", isOther(value) && "border-primary bg-accent")}
						placeholder="Other…"
						value={otherText(value) ?? ""}
						onChange={(text) => onChange({ value: text, other: true })}
						{...dictation}
					/>
				))}
		</div>
	);
}
