"use client";

import { useEffect, useRef, useState } from "react";
import { formatChildElapsed } from "@/src/core";

/**
 * The start (epoch ms) of the turn now running, or undefined while idle. A turn already running at page load starts at
 * the server's `turnStartedAt` (undefined from an older server: no timer for it); a turn that begins while the page is
 * open counts from the moment busy flipped on. Steers inside a turn keep `busy` true, so they never reset it.
 */
export function useTurnStart(busy: boolean, initialTurnStartedAt?: string): number | undefined {
	const first = useRef(true);
	const [start, setStart] = useState<number | undefined>(() => {
		if (!busy || !initialTurnStartedAt) return undefined;
		const t = Date.parse(initialTurnStartedAt);
		return Number.isNaN(t) ? undefined : t;
	});
	useEffect(() => {
		const initial = first.current;
		first.current = false;
		if (!busy) return setStart(undefined);
		if (initial) return; // the initial state above covers the turn running at load
		setStart((s) => s ?? Date.now());
	}, [busy]);
	return busy ? start : undefined;
}

/** Live elapsed time of the running turn, ticking every second; unmounts its interval when idle. */
export function TurnTimer({ startedAt }: { startedAt: number | undefined }) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (startedAt === undefined) return;
		setNow(Date.now());
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
