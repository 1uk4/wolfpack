"use client";

import { cn } from "@/lib/utils";
import { THREAD_COLORS, THREAD_COLOR_KEYS } from "@/src/core";

/** Display names: the stored `teal` key is lime now (see THREAD_COLORS), so label it so. */
const THREAD_COLOR_NAMES: Record<string, string> = { teal: "lime" };

/** The 8 palette colors plus "Automatic" (reset). `value` is the override key; absent = automatic. */
export function ThreadColorPicker({ value, autoHex, onPick }: { value?: string; autoHex?: string; onPick: (key: string | null) => void }) {
	return (
		<div data-testid="thread-color-picker" role="group" aria-label="Thread color" className="flex flex-wrap items-center gap-1.5 px-2 py-1.5">
			{THREAD_COLOR_KEYS.map((key) => (
				<button
					key={key}
					type="button"
					role="menuitemradio"
					aria-checked={value === key}
					aria-label={THREAD_COLOR_NAMES[key] ?? key}
					title={THREAD_COLOR_NAMES[key] ?? key}
					data-testid={`thread-color-${key}`}
					onClick={() => onPick(key)}
					className={cn("size-4 rounded-full ring-offset-1 ring-offset-card transition-transform hover:scale-110", value === key && "ring-2 ring-foreground")}
					style={{ backgroundColor: THREAD_COLORS[key] }}
				/>
			))}
			<button
				type="button"
				role="menuitemradio"
				aria-checked={value === undefined}
				data-testid="thread-color-auto"
				onClick={() => onPick(null)}
				className={cn("ml-1 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted", value === undefined && "bg-muted/60 text-foreground")}
			>
				{autoHex && <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: autoHex }} />}
				Automatic
			</button>
		</div>
	);
}
