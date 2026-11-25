"use client";

import { EyeIcon, MessageSquareIcon, XIcon } from "lucide-react";
import { viewKey } from "./view-descriptor";
import { dismissFrame, useFrameBadges } from "./frame-store";
import { openView, useViewer } from "./viewer-store";
import { setVizMode } from "./viz-mode";

/**
 * One horizontally scrolling row of eye + title badges, one per frame the wolf showed in the thread. Tap opens that frame in
 * visualization mode; × hides the badge for the thread. While the mode is on (`vizOn`) the row starts with a chat icon that leaves it.
 * `onNavigate` is for callers that are not on the thread page (the floating bar): it gets the thread-page href with the frame open.
 */
export function FrameBadges({ wolf, threadId, vizOn, onNavigate }: { wolf: string; threadId: string; vizOn: boolean; onNavigate?: (view: string) => void }) {
	const badges = useFrameBadges(wolf, threadId);
	const viewer = useViewer(wolf, threadId);
	if (badges.length === 0 && !vizOn) return null;
	const top = viewer.stack[viewer.stack.length - 1];
	const shown = viewer.open && top?.kind === "frame" ? top : null;
	return (
		<div
			data-testid="frame-badges"
			className="pointer-events-auto flex min-w-0 flex-nowrap items-center gap-1.5 overflow-x-auto overflow-y-hidden px-1 pb-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
			style={{ scrollbarWidth: "none" }}
		>
			{vizOn && (
				<button
					type="button"
					data-testid="frame-badges-chat"
					aria-label="Show the chat"
					title="Show the transcript again"
					onClick={() => setVizMode(wolf, threadId, false)}
					className="flex size-7 shrink-0 items-center justify-center rounded-full border bg-card text-muted-foreground hover:bg-accent"
				>
					<MessageSquareIcon className="size-4" />
				</button>
			)}
			{badges.map((b) => {
				const active = !!shown && viewKey(shown) === viewKey(b.descriptor);
				return (
					<span
						key={b.objectId}
						data-testid="frame-badge"
						data-object-id={b.objectId}
						className={`flex shrink-0 items-center rounded-full border bg-card font-ui text-xs shadow-sm ${active ? "border-(color:--thread-accent) bg-accent" : ""}`}
					>
						<button
							type="button"
							data-testid="frame-badge-open"
							aria-pressed={active}
							title={b.label}
							onClick={() => {
								openView(wolf, threadId, b.descriptor);
								setVizMode(wolf, threadId, true);
								onNavigate?.(viewKey(b.descriptor));
							}}
							className="flex max-w-[12rem] items-center gap-1 py-1 pl-2 pr-1 hover:text-foreground"
						>
							<EyeIcon className="size-3.5 shrink-0" />
							<span className="truncate">{b.label}</span>
						</button>
						<button
							type="button"
							data-testid="frame-badge-dismiss"
							aria-label={`Hide ${b.label}`}
							onClick={() => {
								dismissFrame(threadId, b.objectId);
								if (active) setVizMode(wolf, threadId, false);
							}}
							className="mr-1 flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-accent"
						>
							<XIcon className="size-3" />
						</button>
					</span>
				);
			})}
		</div>
	);
}
