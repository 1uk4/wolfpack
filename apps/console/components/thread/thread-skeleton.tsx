import { TopBar } from "@/components/shell/top-bar";

/**
 * The thread page's frame while the transcript loads: the same header strip (TopBar, h-15) and a composer
 * placeholder pinned to the bottom, so the real ThreadChat replaces it without shifting the layout.
 */
export function ThreadSkeleton() {
	return (
		<div className="flex h-dvh" data-testid="thread-skeleton" aria-busy="true">
			<div className="flex min-w-0 flex-1 flex-col">
				<TopBar>
					<span className="h-6 w-40 animate-pulse rounded bg-muted motion-reduce:animate-none" />
				</TopBar>
				<div className="min-h-0 flex-1" />
				<div className="mx-auto w-full px-6 pb-4">
					<div className="h-14 animate-pulse rounded-xl border bg-muted/40 motion-reduce:animate-none" />
				</div>
			</div>
		</div>
	);
}
