"use client";

import { useCallback, useRef, useState } from "react";

/**
 * The shared busy/disabled pattern for submit-style buttons (chat send, wolf settings Save, ...).
 *
 * `run()` calls `action`; if it returns a promise, `pending` is true until it settles and any `run()` meanwhile is ignored
 * (a ref guards the same tick, so a double click can never send twice). `busy` = `pending || external`, where `external` is
 * a longer host-known event (graduating, shipping, dictating). Put `busy` on the button: `disabled={busy}`, `aria-busy={busy}`,
 * and show a spinner (see BusyButton in ./busy-button).
 */
export function useBusyAction<A extends unknown[]>(action: (...args: A) => unknown, external = false) {
	const [pending, setPending] = useState(false);
	const inFlight = useRef(false);
	const latest = useRef(action);
	latest.current = action;
	const externalRef = useRef(external);
	externalRef.current = external;
	const run = useCallback((...args: A) => {
		if (inFlight.current || externalRef.current) return;
		const result = latest.current(...args);
		if (result && typeof (result as PromiseLike<unknown>).then === "function") {
			inFlight.current = true;
			setPending(true);
			const done = () => {
				inFlight.current = false;
				setPending(false);
			};
			(result as PromiseLike<unknown>).then(done, done);
		}
		return result;
	}, []);
	return { run, pending, busy: pending || external };
}
