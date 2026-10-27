/**
 * Coalesce refresh requests without losing the last one: while a run is in flight, further calls only set a dirty
 * flag, and exactly one more run follows it. Dropping them (the old behaviour) could leave a list showing the
 * state from before the final event of a burst, e.g. a needs-you dot that never cleared.
 */
export function coalescedRefresh(run: () => Promise<void>): () => Promise<void> {
	let inFlight: Promise<void> | undefined;
	let dirty = false;
	const loop = async (): Promise<void> => {
		try {
			do {
				dirty = false;
				try {
					await run();
				} catch {
					/* run() owns its error handling; a throw must not wedge the loop */
				}
			} while (dirty);
		} finally {
			inFlight = undefined;
		}
	};
	return () => {
		if (inFlight) {
			dirty = true;
			return inFlight;
		}
		inFlight = loop();
		return inFlight;
	};
}
