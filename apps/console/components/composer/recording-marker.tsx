"use client";

import { Loader2Icon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Shows which field the live dictation writes into: a pulsing red dot, a spinner while the run stops. Sits at the field's inner right edge. */
export function RecordingMarker({ state, className }: { state: "live" | "stopping"; className?: string }) {
	return (
		<span data-testid="recording-marker" data-state={state} aria-hidden className={cn("pointer-events-none flex size-3 items-center justify-center", className)}>
			{state === "stopping" ? <Loader2Icon className="size-3 animate-spin text-destructive" /> : <span className="size-2 animate-pulse rounded-full bg-destructive" />}
		</span>
	);
}
