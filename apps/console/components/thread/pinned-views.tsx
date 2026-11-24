"use client";

import { BookOpenIcon, ListTreeIcon, PinIcon, XIcon, type LucideIcon } from "lucide-react";
import { usePinnedViews, unpinView } from "@/components/thread/pin-store";
import { viewKey, type ViewDescriptor } from "@/components/viewer/view-descriptor";
import { useViewer } from "@/components/viewer/viewer-store";

/** Kind icons: work items use the work-list icon (as the work nav link), KB entries the book; unknown kinds fall back to a pin. */
const KIND_ICON: Record<string, LucideIcon> = { work: ListTreeIcon, kb: BookOpenIcon };

/**
 * Chips for the views pinned from the viewer header, one per view (kind icon + title, id when no title). Clicking a chip
 * opens the viewer on it; the x unpins. Rendered at the top of the pinned column.
 */
export function PinnedViewChips({ wolf, threadId }: { wolf: string; threadId: string }) {
	const pins = usePinnedViews(threadId);
	// The viewer store is only touched once something is pinned: a thread with no pins renders nothing and reads nothing.
	return pins.length === 0 ? null : <Chips wolf={wolf} threadId={threadId} pins={pins} />;
}

function Chips({ wolf, threadId, pins }: { wolf: string; threadId: string; pins: readonly ViewDescriptor[] }) {
	const v = useViewer(wolf, threadId);
	return (
		<div className="pointer-events-none flex min-h-0 flex-col" data-testid="pinned-views">
			<div className="mx-auto flex w-full max-w-[46rem] flex-wrap gap-1 px-4 pt-1">
				{pins.map((d) => {
					const Icon = KIND_ICON[d.kind] ?? PinIcon;
					const label = d.title ?? d.id;
					return (
						<div
							key={viewKey(d)}
							data-testid="pinned-view-chip"
							data-view-key={viewKey(d)}
							className="pointer-events-auto flex max-w-full items-center rounded-full border bg-card text-xs text-card-foreground shadow-sm"
						>
							<button
								type="button"
								data-testid="pinned-view-open"
								title={label}
								onClick={() => v.openView(d)}
								className="flex min-w-0 items-center gap-1.5 rounded-l-full py-1 pl-2.5 pr-1 hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring"
							>
								<Icon className="size-3 shrink-0 text-muted-foreground" />
								<span className="max-w-[16rem] truncate">{label}</span>
							</button>
							<button
								type="button"
								aria-label={`Unpin ${label}`}
								data-testid="pinned-view-unpin"
								onClick={() => unpinView(threadId, d)}
								className="flex size-6 items-center justify-center rounded-r-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
							>
								<XIcon className="size-3" />
							</button>
						</div>
					);
				})}
			</div>
		</div>
	);
}
