"use client";

import { cn } from "@/lib/utils";
import type { CardField } from "@wolfpack/client";
import { Indicator, OPTION_ROW } from "./shared";
import type { FieldRendererProps } from "./types";

export function ConfirmRenderer({
	field,
	value,
	readOnly,
	onChange,
	onClear,
	labelledBy,
}: FieldRendererProps<Extract<CardField, { kind: "confirm" }>>) {
	const picked = typeof value?.value === "boolean" ? value.value : undefined;
	const note = value && "note" in value ? value.note : undefined;
	const btn = (which: boolean, label: string, testid: string) => (
		<button
			type="button"
			aria-pressed={picked === which}
			disabled={readOnly}
			data-testid={testid}
			onClick={() => (picked === which && field.optional ? onClear() : onChange({ value: which, ...(note ? { note } : {}) }))}
			className={cn(
				OPTION_ROW,
				"w-auto items-center pr-4",
				picked === which ? "border-primary bg-accent" : "enabled:hover:bg-accent/50",
				readOnly && picked !== which && "text-muted-foreground",
			)}
		>
			<Indicator shape="radio" on={picked === which} />
			{label}
		</button>
	);
	return (
		<div className="flex flex-wrap gap-2" role="group" aria-labelledby={labelledBy} data-testid="card-confirm-group">
			{btn(true, field.confirmLabel ?? "Yes", "card-confirm")}
			{btn(false, field.rejectLabel ?? "No", "card-reject")}
		</div>
	);
}

