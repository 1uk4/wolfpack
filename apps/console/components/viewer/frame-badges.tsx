"use client";

import type { ReactNode } from "react";
import { EyeIcon, MessageSquareIcon, XIcon } from "lucide-react";
import { Hint } from "@/components/ui/hint";
import { viewKey } from "./view-descriptor";
import { dismissFrame, useFrameBadges } from "./frame-store";
import { openView, useViewer } from "./viewer-store";
import { setVizMode } from "./viz-mode";
import { useEyeOpen } from "@/src/core/ui/bar-eye";

/**
 * One horizontally scrolling row of eye + title badges, one per frame the wolf showed in the thread. Tap opens that frame in
 * visualization mode; × hides the badge for the thread. While the mode is on (`vizOn`) the row starts with a chat icon that leaves it.
 * `onNavigate` is for callers that are not on the thread page (the floating bar): it gets the thread-page href with the frame open.
 */
export function FrameBadges({ wolf, threadId, vizOn, onNavigate, lead, bar = false }: { wolf: string; threadId: string; vizOn: boolean; onNavigate?: (view: string) => void; lead?: ReactNode; bar?: boolean }) {
	const all = useFrameBadges(wolf, threadId);
	const [eyeOpen] = useEyeOpen();
	// The bar tucks its frame chips behind the eye button (BarEyeButton) unless the owner opened it; in the visualization mode the chips are the navigation, so they stay.
	const badges = bar && !eyeOpen && !vizOn ? [] : all;
	const viewer = useViewer(wolf, threadId);
	if (badges.length === 0 && !vizOn && !lead) return null;
	const top = viewer.stack[viewer.stack.length - 1];
	const shown = viewer.open && top?.kind === "frame" ? top : null;
	return (
		<div
			data-testid="frame-badges"
			role="toolbar"
			aria-label="Frames"
			className={`pointer-events-auto flex min-w-0 flex-nowrap items-center gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${bar ? "px-3 py-2 [mask-image:linear-gradient(to_right,transparent,#000_12px,#000_calc(100%-12px),transparent)]" : "px-1 pb-1.5"}`}
		>
			{lead}
			{vizOn && (
				<Hint label="Show the transcript again">
					<button
						type="button"
						data-testid="frame-badges-chat"
						aria-label="Show the chat"
						onClick={() => setVizMode(wolf, threadId, false)}
						className="flex size-7 shrink-0 items-center justify-center rounded-full border bg-card text-muted-foreground hover:bg-accent max-md:size-11"
					>
						<MessageSquareIcon className="size-4" />
					</button>
				</Hint>
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
						<Hint label={b.fullTitle}>
							<button
								type="button"
								data-testid="frame-badge-open"
								aria-pressed={active}
								aria-label={b.fullTitle}
								onClick={() => {
									openView(wolf, threadId, b.descriptor);
									// Another page: navigate first; the thread page turns viz mode on when it arrives, so a failed navigation leaves the chat visible.
									if (onNavigate) onNavigate(viewKey(b.descriptor));
									else setVizMode(wolf, threadId, true);
								}}
								className="flex max-w-[12rem] items-center gap-1 py-1 pl-2 pr-1 hover:text-foreground max-md:min-h-11"
							>
								<EyeIcon className="size-3 shrink-0 text-muted-foreground" />
								<span className="truncate">{b.label}</span>
							</button>
						</Hint>
						<Hint label={`Hide ${b.fullTitle}`}>
							<button
								type="button"
								data-testid="frame-badge-dismiss"
								aria-label={`Hide ${b.fullTitle}`}
								onClick={() => {
									dismissFrame(threadId, b.objectId);
									if (active) setVizMode(wolf, threadId, false);
								}}
								className="mr-1 flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-accent max-md:size-11"
							>
								<XIcon className="size-3" />
							</button>
						</Hint>
					</span>
				);
			})}
		</div>
	);
}

/** The bar header's eye: opens or tucks away the frame chips. Its badge counts the frames the wolf showed in the thread; with none it is disabled. */
export function BarEyeButton({ wolf, threadId }: { wolf: string; threadId: string }) {
	const count = useFrameBadges(wolf, threadId).length;
	const [open, setOpen] = useEyeOpen();
	const label = count === 0 ? "No frames to show" : open ? `Hide the frames (${count})` : `Show the frames (${count})`;
	return (
		<Hint label={label}>
			<button
				type="button"
				data-testid="bar-eye"
				aria-label={label}
				aria-pressed={open && count > 0}
				disabled={count === 0}
				onClick={() => setOpen(!open)}
				className="relative rounded-md p-1 text-muted-foreground hover:bg-accent disabled:opacity-40"
			>
				<EyeIcon aria-hidden className="size-4" />
				<span data-testid="bar-eye-count" className="absolute -right-0.5 -top-0.5 min-w-3.5 rounded-full bg-primary px-1 text-center font-ui text-[10px] leading-[14px] text-primary-foreground">{count}</span>
			</button>
		</Hint>
	);
}
