"use client";

import { SettingsIcon } from "lucide-react";
import { usePackHealth } from "@/components/pack/pack-health";
import { openPackPage } from "@/components/pack/pack-nav";
import { cn } from "@/lib/utils";
import { packEntrySummary, type Tone } from "@/src/core";

const DOT: Record<Tone, string> = { red: "bg-red-500", amber: "bg-amber-500", grey: "bg-muted-foreground/50", green: "bg-emerald-500" };
const TEXT: Record<Tone, string> = { red: "text-red-600 dark:text-red-400", amber: "text-amber-600 dark:text-amber-400", grey: "text-muted-foreground", green: "text-emerald-600 dark:text-emerald-400" };

/** The sidebar's Settings entry (the gear): opens the Pack page, and says how the pack is ("All good", "2 need attention", "sfo-01 offline"). */
export function PackSettingsEntry({ onOpen }: { onOpen?: () => void }) {
	const h = usePackHealth();
	const sum = packEntrySummary({ snapshot: h.snapshot, reachable: h.reachable, lastSeenAt: h.lastSeenAt, now: h.now });
	return (
		<button
			type="button"
			data-testid="settings-entry"
			data-tone={sum.tone}
			aria-label={`Settings: ${sum.label}`}
			onClick={() => {
				openPackPage();
				onOpen?.();
			}}
			className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground max-md:py-2.5"
		>
			<SettingsIcon className="size-3 shrink-0" />
			<span className="uppercase tracking-wider">Settings</span>
			<span aria-hidden className={cn("ml-auto size-2 shrink-0 rounded-full", DOT[sum.tone])} />
			<span className={cn("max-w-[55%] truncate", sum.tone !== "green" && TEXT[sum.tone])}>{sum.label}</span>
		</button>
	);
}
