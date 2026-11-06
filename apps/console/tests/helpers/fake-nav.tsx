/** A tiny in-memory Next navigation: router (push/replace/back/forward), pathname and search params over a history stack. */
import React, { useState, type ReactNode } from "react";

const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { PathnameContext, SearchParamsContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime.js");

export interface NavLog {
	stack: string[];
	/** history.state per entry (Next owns it; the reader stamps a marker into it with replaceState). */
	states: unknown[];
	index: number;
}

export const navLog: NavLog = { stack: [], states: [], index: 0 };
// window.history over the same stack: `state` is the current entry's, replaceState rewrites it.
Object.defineProperty(window, "history", {
	configurable: true,
	value: {
		get state() {
			return navLog.states[navLog.index] ?? null;
		},
		replaceState(st: unknown) {
			navLog.states[navLog.index] = st;
		},
	},
});
export const currentUrl = (): string => navLog.stack[navLog.index]!;
let setIdx: ((i: number) => void) | null = null;
/** Browser Back / Forward. */
export const historyBack = () => { if (navLog.index > 0) setIdx?.(navLog.index - 1); };
export const historyForward = () => { if (navLog.index < navLog.stack.length - 1) setIdx?.(navLog.index + 1); };

export function FakeNav({ start, children }: { start: string; children: ReactNode }) {
	useState(() => {
		navLog.stack = [start];
		navLog.states = [null];
		navLog.index = 0;
	});
	const [, setTick] = useState(0);
	const setIndex = (i: number) => { navLog.index = i; setTick((t) => t + 1); };
	setIdx = setIndex;
	const router = {
		push: (h: string) => {
			navLog.stack = [...navLog.stack.slice(0, navLog.index + 1), h];
			navLog.states = [...navLog.states.slice(0, navLog.index + 1), null];
			setIndex(navLog.stack.length - 1);
		},
		replace: (h: string) => {
			navLog.stack[navLog.index] = h;
			navLog.states[navLog.index] = null; // Next writes fresh state on replace: any marker is lost
			setIndex(navLog.index);
		},
		back: historyBack,
		forward: historyForward,
	};
	const url = new URL(currentUrl(), "http://x");
	return (
		<AppRouterContext.Provider value={router as never}>
			<PathnameContext.Provider value={url.pathname}>
				<SearchParamsContext.Provider value={url.searchParams as never}>{children}</SearchParamsContext.Provider>
			</PathnameContext.Provider>
		</AppRouterContext.Provider>
	);
}
