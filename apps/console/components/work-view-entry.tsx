"use client";

/**
 * The Work view's entry points, kept apart from the overlay itself: the overlay draws the shared TopBar, which
 * imports the sidebar, so the sidebar's own Work entry must not import the overlay back. The provider
 * (work-view.tsx) supplies the context; outside it these entry points do nothing.
 */

import { createContext, useContext } from "react";
import { ListTreeIcon } from "lucide-react";

export interface WorkViewApi {
	open: () => void;
	close: () => void;
	isOpen: boolean;
}

export const WorkViewContext = createContext<WorkViewApi>({ open: () => {}, close: () => {}, isOpen: false });

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
	return (
		<button
			type="button"
			data-testid="nav-work"
			aria-haspopup="dialog"
			aria-expanded={isOpen}
			onClick={open}
			className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
		>
			<ListTreeIcon className="size-3" />
			Work
		</button>
	);
}
