/** Stable identity of the git state the branch graph depends on (not the status object, which is new on every refresh). */
export function graphKey(status: { branch: string; ahead: number; behind: number; commits: { sha: string }[] } | undefined): string {
	if (!status) return "";
	return `${status.branch}@${status.commits[0]?.sha ?? ""}+${status.ahead}-${status.behind}`;
}

/**
 * Latest-wins request tracking: `begin()` returns a check that is true only until the next `begin()`. A slow response
 * is dropped only when a newer request has started, never because an unrelated re-render happened.
 */
export function newestRequest(): () => () => boolean {
	let seq = 0;
	return () => {
		const mine = ++seq;
		return () => mine === seq;
	};
}
