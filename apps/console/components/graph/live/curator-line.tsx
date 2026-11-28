"use client";

/** The Memory tab's curator line: "Curator · 3 pending · 1 filing". Pending comes from the shared pending-queue store (no poll of its own), filing from the memory events. Nothing when both are 0. */
import { useSyncExternalStore } from "react";
import { InboxIcon } from "lucide-react";
import type { ActivityEvent } from "@wolfpack/protocol";
import { curatorCounts, curatorText } from "@/src/core";
import { getKbPending, subscribeKbPending } from "./kb-life-store";

export function CuratorLine({ events }: { events: readonly { event: ActivityEvent; at: number }[] }) {
	const queue = useSyncExternalStore(subscribeKbPending, getKbPending, getKbPending);
	const counts = curatorCounts(queue.items.length, events);
	const text = curatorText(counts);
	if (!text) return null;
	const perWolf = Object.entries(queue.items.reduce<Record<string, number>>((m, i) => ((m[i.wolf] = (m[i.wolf] ?? 0) + 1), m), {}))
		.map(([w, n]) => `${w} ${n}`)
		.join(", ");
	return (
		<div title={perWolf ? `Waiting: ${perWolf}` : undefined} className="flex items-center gap-1.5 px-2.5 pt-1.5 text-[11px] leading-4 text-muted-foreground">
			<InboxIcon className="size-3 shrink-0" aria-hidden />
			<span className="truncate tabular-nums">{text}</span>
		</div>
	);
}
