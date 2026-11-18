"use client";

import { CardTextInput } from "./shared";
import type { FieldRendererProps } from "./types";

/** Free text; also the renderer of any kind this console does not know (its value is read as text). */
export function FreeTextRenderer({ value, readOnly, onChange, compact, dictation }: FieldRendererProps<{ kind: string }>) {
	const text = typeof value?.value === "string" ? value.value : "";
	if (readOnly) {
		return (
			<div className="wp-prose whitespace-pre-wrap" data-testid="card-answer-text">
				“{text}”
			</div>
		);
	}
	return (
		<CardTextInput
			multiline
			testId="card-text"
			className={compact ? "min-h-12 w-full resize-y px-2 py-1" : "min-h-20 w-full resize-y px-3 py-2"}
			value={text}
			onChange={(t) => onChange({ value: t })}
			placeholder="Your answer…"
			{...dictation}
		/>
	);
}
