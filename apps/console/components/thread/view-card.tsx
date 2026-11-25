"use client";

import { useContext } from "react";
import { BookOpenIcon, ListTreeIcon, PinIcon, type LucideIcon } from "lucide-react";
import type { ObjectCardProps } from "@/components/thread/card-registry";
import { ViewHostContext } from "@/components/viewer/use-view-objects";
import { openView } from "@/components/viewer/viewer-store";

const KIND_ICON: Record<string, LucideIcon> = { work: ListTreeIcon, kb: BookOpenIcon };

/** One-line transcript card of a show_view object: "Opened <title or id>"; click re-opens the viewer on it. */
export function ViewCard({ data }: ObjectCardProps) {
	const host = useContext(ViewHostContext);
	const d = data as { kind?: string; id?: string; title?: string } | undefined;
	if (!d || typeof d.kind !== "string" || typeof d.id !== "string") return null;
	const Icon = KIND_ICON[d.kind] ?? PinIcon;
	const label = d.title ?? d.id;
	return (
		<button
			type="button"
			data-testid="view-card"
			title={label}
			onClick={() => host && openView(host.wolf, host.threadId, { kind: d.kind!, id: d.id!, ...(d.title ? { title: d.title } : {}) })}
			className="my-1 flex max-w-full items-center gap-1.5 rounded-md border bg-card px-2.5 py-1 text-xs text-card-foreground hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring"
		>
			<Icon className="size-3 shrink-0 text-muted-foreground" />
			<span className="truncate">Opened {label}</span>
		</button>
	);
}
