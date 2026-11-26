/**
 * The key of a thread in the live state, and the owner's `<wolf>/<slug>` target format.
 * wolfd thread ids are usually already wolf-prefixed (`1uk4/feature-x`); a roster row or URL slug is bare (`feature-x`).
 * Both give `1uk4/feature-x`. Idempotent. An id prefixed with ANOTHER wolf (`hal/x` under `1uk4`) is treated as a slug: `1uk4/hal/x`.
 */
export function threadKey(wolf: string, threadId: string): string {
	return threadId.startsWith(`${wolf}/`) ? threadId : `${wolf}/${threadId}`;
}
