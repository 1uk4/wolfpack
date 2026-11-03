"use client";

import { useEffect, useRef, useState } from "react";
import { formatChildElapsed } from "@/src/core";

const parse = (iso: string | undefined): number | undefined => {
	if (!iso) return undefined;
	const t = Date.parse(iso);
	return Number.isNaN(t) ? undefined : t;
};

/**
 * The start (epoch ms) of the turn now running, or undefined while idle / when there is nothing to count from.
 *
 * Preference order: the server's start of this turn (`serverStartedAt`: the turn-start event / snapshot, via the
 * session), then — for the turn running at page load only — the detail's `initialTurnStartedAt`, then the local clock
 * from the moment busy flipped on. The local clock is a fallback ONLY once this page has seen a server turn start
 * value (so the server is known to send them, and the gap before its turn-start event is covered). An older server
 * never sends one: no value is ever seen, so no timer is shown (today's display).
 *
 * State is per thread: a different `threadId` starts over, so a start never carries across a thread switch.
 */
export function useTurnStart(threadId: string, busy: boolean, serverStartedAt?: string, initialTurnStartedAt?: string): number | undefined {
	const memo = useRef({ threadId, seen: false, initialDone: false });
	if (memo.current.threadId !== threadId) memo.current = { threadId, seen: false, initialDone: false };
	const [local, setLocal] = useState<{ threadId: string; at: number } | undefined>();

	const server = parse(serverStartedAt) ?? (memo.current.initialDone ? undefined : parse(initialTurnStartedAt));
	if (server !== undefined) memo.current.seen = true;

	useEffect(() => {
		if (!busy) {
			memo.current.initialDone = true; // the load-time turn is over: its initial value must not seed the next one
			setLocal(undefined);
			return;
		}
		if (memo.current.seen) setLocal((s) => (s?.threadId === threadId ? s : { threadId, at: Date.now() }));
	}, [busy, threadId]);

	if (!busy) return undefined;
	return server ?? (local?.threadId === threadId ? local.at : undefined);
}

/** Live elapsed time of the running turn, ticking every second; the interval is cleared when idle or unmounted. */
export function TurnTimer({ startedAt }: { startedAt: number | undefined }) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (startedAt === undefined) return;
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, [startedAt]);
	if (startedAt === undefined) return null;
	return (
		<span data-testid="turn-timer" title="Time the current turn has been running" className="shrink-0 text-xs tabular-nums text-muted-foreground">
			{formatChildElapsed(Math.max(0, now - startedAt))}
		</span>
	);
}
