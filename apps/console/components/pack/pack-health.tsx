"use client";

/**
 * PACK HEALTH in the sidebar (work-wolfpack-6imFEq7): the shared health snapshot hook and the host that mounts the Pack modal.
 * The data is the console's own /api/health (no hub call), so it keeps working with the hub down; if the console itself stops
 * answering, the bar says so from the last snapshot and never goes blank.
 *   data:  one shared, ref-counted subscription (components/pack/pack-health-store.ts → src/core/pack/pack-health-connection.ts), so
 *          the desktop and phone sidebars share one stream.
 *   modal: rendered once by <PackHealthHost/> (in the app shell), its open state in the store, so closing the phone list
 *          layer under it doesn't unmount it.
 *   The Machines section itself is components/pack/pack-machines.tsx.
 *   dev:   ?healthFixture=<name> (components/pack/pack-health-fixtures.ts; not in production).
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { PackPanel } from "@/components/pack/pack-panel";
import {
	closePackHealth,
	focusPackHealthOpener,
	getPackHealth,
	getServerPackHealth,
	openPackHealth,
	subscribePackHealth,
	watchPackHealth,
	type PackHealthState,
} from "@/components/pack/pack-health-store";
import { kbRelativeTime, packSectionFromSearch, BACK_MS, packSummary, type HealthSnapshotView } from "@/src/core";

const TICK_MS = 2_000;

type HealthState = PackHealthState & { now: number };

/** When the latest "back" window ends (0 when none): a link that turned ok after being anything else. */
function backUntil(snapshot: HealthSnapshotView | null): number {
	let until = 0;
	for (const l of snapshot?.links ?? []) {
		const last = l.history[l.history.length - 1];
		if (l.status === "ok" && l.history.length >= 2 && last?.status === "ok") until = Math.max(until, Date.parse(last.at) + BACK_MS);
	}
	return until;
}

/**
 * The shared snapshot plus a clock. The clock ticks every 2 s only while the modal is open or a "back" window is pending;
 * otherwise it moves with each store update (a snapshot or a failed poll).
 */
export function usePackHealth(): HealthState {
	const s = useSyncExternalStore(subscribePackHealth, getPackHealth, getServerPackHealth);
	const [now, setNow] = useState(() => Date.now());
	const until = backUntil(s.snapshot);
	useEffect(() => {
		setNow(Date.now());
		const ticking = () => s.modalOpen || Date.now() < until;
		if (!ticking()) return;
		const t = setInterval(() => {
			setNow(Date.now());
			if (!ticking()) clearInterval(t);
		}, TICK_MS);
		return () => clearInterval(t);
	}, [s.modalOpen, until, s.updatedAt]);
	return { ...s, now };
}

/** What the live region says: the overall summary without the ticking age, so only real changes are announced. */
function announcement(s: PackHealthState): string {
	if (!s.reachable) return "Pack health: console unreachable";
	if (!s.snapshot) return "";
	return `Pack health: ${packSummary({ snapshot: s.snapshot, reachable: true, now: s.updatedAt }).label}`;
}

/**
 * Rendered once in the app shell: the modal (portaled to body, above the phone list layer and outside the sidebar's
 * aria-hidden aside) and a polite live region for changes of the overall summary. It watches the store without counting
 * as a subscriber; the bars and the open modal are the subscribers (openPackHealth takes the modal's hold on the stream,
 * closePackHealth drops it, and unmounting the host with the modal open closes it).
 */
export function PackHealthHost() {
	const s = useSyncExternalStore(watchPackHealth, getPackHealth, getServerPackHealth);
	const said = announcement(s);
	const prev = useRef("");
	const [live, setLive] = useState("");
	useEffect(() => {
		if (said === "") return;
		if (prev.current !== "" && said !== prev.current) setLive(said); // the state on page load is not news
		prev.current = said;
	}, [said]);
	useEffect(() => {
		// ?pack=<section> opens the Pack on page load (an unknown name opens Machines).
		const wanted = packSectionFromSearch(window.location.search);
		if (wanted !== null) openPackHealth(null, wanted);
		return () => void (getPackHealth().modalOpen && closePackHealth());
	}, []);
	const wasOpen = useRef(false);
	useEffect(() => {
		if (wasOpen.current && !s.modalOpen) focusPackHealthOpener(); // after OverlayShell's own restore, which may hit a hidden bar
		wasOpen.current = s.modalOpen;
	}, [s.modalOpen]);
	return (
		<>
			<div aria-live="polite" role="status" className="sr-only" data-testid="pack-health-live">
				{live}
			</div>
			{s.modalOpen && typeof document !== "undefined" && createPortal(<PackPanel />, document.body)}
		</>
	);
}

/** The hub curator is stuck (hub `sweep.stuckSince`): a warning row. Presentational. */
export function CuratorStuckWarning({ stuckSince, now }: { stuckSince: string; now: number }) {
	return (
		<p data-testid="pack-curator-stuck" role="alert" className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-700 dark:text-amber-300">
			Hub curator stuck since {kbRelativeTime(stuckSince, now).replace(/ ago$/, " ago")}: its sweep ran past the time budget and hasn't stopped, so new sweeps are skipped until it does.
		</p>
	);
}
