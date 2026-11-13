"use client";

import { cn } from "@/lib/utils";
import { THREAD_COLORS, THREAD_COLOR_KEYS } from "@/src/core";

/** Display names: the stored `teal` key is lime now (see THREAD_COLORS), so label it so. */
const THREAD_COLOR_NAMES: Record<string, string> = { teal: "lime" };

/** The wolf color picker (Settings): the 8 palette colors plus "Automatic" (reset). `value` is the override key; absent = automatic. */
export function ThreadColorPicker({ value, autoHex, onPick }: { value?: string; autoHex?: string; onPick: (key: string | null) => void }) {
	return (
		<div data-testid="thread-color-picker" role="radiogroup" aria-label="Wolf color" className="flex flex-wrap items-center gap-1.5 py-1 max-md:gap-0">
			{THREAD_COLOR_KEYS.map((key) => (
				// On phones the button is a 44px tap area and the dot is drawn inside it at its usual 16px; from md up the button is the dot.
				<button
					key={key}
					type="button"
					role="radio"
					aria-checked={value === key}
					aria-label={THREAD_COLOR_NAMES[key] ?? key}
					title={THREAD_COLOR_NAMES[key] ?? key}
					data-testid={`thread-color-${key}`}
					onClick={() => onPick(key)}
					className="flex size-4 items-center justify-center max-md:size-11"
				>
					<span aria-hidden className={cn("block size-4 rounded-full ring-offset-1 ring-offset-card transition-transform hover:scale-110", value === key && "ring-2 ring-foreground")} style={{ backgroundColor: THREAD_COLORS[key] }} />
				</button>
			))}
			<button
				type="button"
				role="radio"
				aria-checked={value === undefined}
				data-testid="thread-color-auto"
				onClick={() => onPick(null)}
				className={cn("ml-1 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs max-md:min-h-11 max-md:px-3 text-muted-foreground hover:bg-muted", value === undefined && "bg-muted/60 text-foreground")}
			>
				{autoHex && <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: autoHex }} />}
				Automatic
			</button>
		</div>
	);
}
