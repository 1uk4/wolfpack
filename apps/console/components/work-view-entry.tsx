"use client";

/**
 * The Work view's entry points, kept apart from the overlay itself: the overlay draws the shared TopBar, which
 * imports the sidebar, so the sidebar's own Work entry must not import the overlay back. The provider
 * (work-view.tsx) supplies the context; outside it these entry points do nothing.
 */

import { createContext, useContext } from "react";
import { usePathname } from "next/navigation";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { ListTreeIcon } from "lucide-react";
import type { WorkRouteView } from "@/src/core";

/** A row the table selected; `seq` makes re-selecting the same row a new request. */
export interface WorkSelection {
	id: string;
	seq: number;
}

export interface WorkViewApi {
	open: () => void;
	close: () => void;
	isOpen: boolean;
	/** The table's selection, which the graph acts on (null: the full-screen table). */
	selection: WorkSelection | null;
	select: (id: string) => void;
	/** Forget the table's last selection request (the graph's own selection is not touched). */
	clearSelection: () => void;
	/** Full-screen table (true) vs the left column over the graph (false, the default). Remembered. */
	expanded: boolean;
	setExpanded: (expanded: boolean) => void;
	/** The graph's side pane is open: Esc closes it before the Work list. */
	graphPaneOpen: boolean;
	publishPane: (open: boolean) => void;
	/** The graph's selected route, as the table lights it (null: nothing selected on the graph). */
	routeView: WorkRouteView | null;
	publishRoute: (view: WorkRouteView | null) => void;
	/** The split's left column width (px), remembered; `persist` writes it. */
	colWidth: number;
	setColWidth: (width: number, persist?: boolean) => void;
}

export const WorkViewContext = createContext<WorkViewApi>({
	open: () => {},
	close: () => {},
	isOpen: false,
	selection: null,
	select: () => {},
	clearSelection: () => {},
	expanded: false,
	setExpanded: () => {},
	graphPaneOpen: false,
	publishPane: () => {},
	routeView: null,
	publishRoute: () => {},
	colWidth: 0,
	setColWidth: () => {},
});

/** The entry points' hook: a no-op outside the provider (pure SSR renders of the header). */
export const useWorkView = (): WorkViewApi => useContext(WorkViewContext);

/** The Work button in the graph header. */
export function WorkButton() {
	const { open } = useWorkView();
	return (
		<button
			type="button"
			data-testid="work-open"
			onClick={open}
			className="flex h-8 shrink-0 items-center gap-1.5 rounded-xl border bg-card/85 px-2.5 text-xs text-muted-foreground shadow-lg backdrop-blur transition-colors hover:bg-accent hover:text-foreground"
		>
			<ListTreeIcon className="size-3.5" />
			Work
		</button>
	);
}

/** The sidebar nav's Work entry: the same overlay as the graph header's button. */
export function WorkNavEntry() {
	const { open, isOpen } = useWorkView();
	const router = useContext(AppRouterContext);
	const pathname = usePathname();
	// Selecting a row splits the view over the graph, so the nav opens the graph page when you're elsewhere.
	const onClick = () => {
		if (pathname != null && pathname !== "/") router?.push("/");
		open();
	};
	return (
		<button
			type="button"
			data-testid="nav-work"
			aria-haspopup="dialog"
			aria-expanded={isOpen}
			onClick={onClick}
			className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
		>
			<ListTreeIcon className="size-3" />
			Work
		</button>
	);
}
