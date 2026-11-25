"use client";

import { createContext, useContext, useEffect, useRef } from "react";

/** Header actions a renderer can contribute. Only `reload` today: the header shows a Reload button, and a pull on the phone sheet header calls it. */
export interface ViewerActions {
	setReload: (fn: (() => void) | null) => void;
}

export const ViewerActionsContext = createContext<ViewerActions | null>(null);

/** Registers `fn` as the view's reload action while mounted (no-op outside a viewer panel). Always calls the latest `fn`. */
export function useViewerReload(fn: () => void): void {
	const actions = useContext(ViewerActionsContext);
	const latest = useRef(fn);
	latest.current = fn;
	useEffect(() => {
		actions?.setReload(() => latest.current());
		return () => actions?.setReload(null);
	}, [actions]);
}
