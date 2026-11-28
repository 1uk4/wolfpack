"use client";

/** The graph toolbar's Activity button: opens and closes the Activity panel; a small badge counts events that arrived while it was closed. */
import { ActivityIcon } from "lucide-react";
import { Hint } from "@/components/ui/hint";
import { toggleActivityPanel, useActivityPanel } from "./activity-panel-store";

export function ActivityToggle() {
	const { open, unseen } = useActivityPanel();
	return (
		<Hint label="Activity" side="top">
			<button
				type="button"
				onClick={() => toggleActivityPanel()}
				aria-label={unseen > 0 && !open ? `Activity, ${unseen} new` : "Activity"}
				aria-pressed={open}
				className="relative flex size-9 items-center justify-center rounded-xl border bg-card/85 shadow-lg backdrop-blur transition-colors before:absolute before:-inset-[5px] before:content-[''] hover:bg-accent"
			>
				<ActivityIcon className="size-4" />
				{unseen > 0 && !open && (
					<span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium leading-none tabular-nums text-primary-foreground">{unseen > 99 ? "99+" : unseen}</span>
				)}
			</button>
		</Hint>
	);
}
