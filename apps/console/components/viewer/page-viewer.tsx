"use client";

import { useMemo, type ReactNode } from "react";
import { pageHost } from "./viewer-host";
import { ViewerPanel } from "./viewer-panel";
import { ViewerProvider } from "./viewer-context";

/**
 * Wraps a non-thread page body with the viewer: the content flexes, the panel is a right column on desktop and a sheet on
 * phone. Own stack under `wolfpack:viewer:page:<scope>`, no pins, no show_view arrivals. Triggers inside open it for the
 * allowed kinds only; anything else navigates as usual.
 */
export function PageViewer({ scope, allowedKinds, urlSync = true, children }: { scope: string; allowedKinds: readonly string[] | "all"; urlSync?: boolean; children: ReactNode }) {
	const kinds = allowedKinds === "all" ? "all" : allowedKinds.join(",");
	// eslint-disable-next-line react-hooks/exhaustive-deps -- `kinds` is the stable value of allowedKinds
	const host = useMemo(() => pageHost(scope, allowedKinds, urlSync), [scope, kinds, urlSync]);
	return (
		<ViewerProvider host={host}>
			{/* The content column scrolls on its own; the panel is a sibling, so it stays in view while the page scrolls. */}
			<div className="flex h-full max-h-[100dvh] min-h-0 w-full md:sticky md:top-0">
				<div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden pb-6">{children}</div>
				<ViewerPanel host={host} />
			</div>
		</ViewerProvider>
	);
}
