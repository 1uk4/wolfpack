"use client";

/**
 * KB life, browser side: (1) the memory-pipeline events the log shows (collected from the shared live feed, folded by src/core kb-life-log),
 * (2) the hover bus between the log and the map (the log sets it, the live layer rings the matching wolf / node / flight / curator),
 * (3) a dev-only scripted demo (`?kbdemo=1`) that feeds sample events through the SAME pipeline as real ones.
 */
import { useEffect, useMemo, useState } from "react";
import type { ActivityEvent } from "@wolfpack/protocol";
import { foldEvents, isKbVerb, type KbLogFocus, type KbLogRow } from "@/src/core";
import { acquireLiveFeed, injectLiveAction, onLiveAction } from "./live-store";

const MAX_EVENTS = 600;
const EMIT_MS = 250;

/** The memory events seen since the page opened, oldest first, with the browser time each arrived. */
export function useKbLiveRows(): KbLogRow[] {
	const [events, setEvents] = useState<{ event: ActivityEvent; at: number }[]>([]);
	useEffect(() => {
		const release = acquireLiveFeed();
		let buf: { event: ActivityEvent; at: number }[] = [];
		let timer: ReturnType<typeof setTimeout> | null = null;
		const flush = () => {
			timer = null;
			const add = buf;
			buf = [];
			setEvents((cur) => [...cur, ...add].slice(-MAX_EVENTS));
		};
		const off = onLiveAction((a) => {
			if (a.type !== "event" || !isKbVerb(a.event.verb)) return;
			buf.push({ event: a.event, at: a.now });
			if (!timer) timer = setTimeout(flush, EMIT_MS);
		});
		const offReset = onKbReset(() => {
			buf = [];
			setEvents([]);
		});
		return () => {
			off();
			offReset();
			release();
			if (timer) clearTimeout(timer);
		};
	}, []);
	return useMemo(() => foldEvents(events), [events]);
}

// ── reset bus: the demo ending clears the log rows and the map's KB state ──
const resetSubs = new Set<() => void>();
export const onKbReset = (fn: () => void): (() => void) => (resetSubs.add(fn), () => void resetSubs.delete(fn));
export const resetKbLife = (): void => resetSubs.forEach((fn) => fn());

// ── hover bus ──
let hover: KbLogFocus | null = null;
const hoverSubs = new Set<() => void>();
export function setKbHover(f: KbLogFocus | null): void {
	hover = f;
	hoverSubs.forEach((fn) => fn());
}
export const getKbHover = (): KbLogFocus | null => hover;
export function subscribeKbHover(fn: () => void): () => void {
	hoverSubs.add(fn);
	return () => void hoverSubs.delete(fn);
}

// ── demo ──
/** The demo plays as a made-up wolf, never a real one. */
export const DEMO_WOLF = "demo-wolf";
const wolfActor = { kind: "wolf", wolf: DEMO_WOLF } as const;
const hubActor = { kind: "hub", title: "curator" } as const;

/** One scripted cycle (ms offset, event). Real event shapes; `c` makes ids unique per cycle. */
export function demoCycle(c: number): { at: number; event: Omit<ActivityEvent, "id" | "ts" | "v" | "pack" | "ttlMs"> }[] {
	const t = (i: number) => `demo-${c}-t${i}`;
	const wolfBase = { actor: wolfActor };
	const out: { at: number; event: Omit<ActivityEvent, "id" | "ts" | "v" | "pack" | "ttlMs"> }[] = [];
	[6000, 12000, 18000, 25000, 33000, 40000].forEach((count, i) => out.push({ at: 600 + i * 1400, event: { ...wolfBase, verb: "memory-observe", detail: { count, capacity: 40000 } } }));
	out.push({ at: 10000, event: { ...wolfBase, verb: "memory-consolidate", detail: { count: 14, topicIds: [t(1), t(2), t(3)] } } });
	[1, 2, 3].forEach((i) => out.push({ at: 12000 + i * 600, event: { ...wolfBase, verb: "memory-promote", target: { kind: "domain", id: "wolfpack" }, detail: { ref: `demo-c-${c}-${i}`, topicIds: [t(i)] } } }));
	const outcomes = ["create", "merge", "reject"];
	[1, 2, 3].forEach((i) => {
		const base = 21000 + (i - 1) * 4500;
		out.push({ at: base, event: { actor: hubActor, verb: "curate-start", detail: { ref: t(i), topicIds: [t(i)] } } });
		const o = outcomes[i - 1]!;
		out.push({ at: base + 2500, event: { actor: hubActor, verb: "curate-done", ...(o === "reject" ? {} : { target: { kind: "kb-entry", id: `kb-demo-${i}`, domain: "wolfpack", title: i === 1 ? "Demo: new topic" : "Demo: merged topic" } }), detail: { outcome: o, ref: t(i), topicIds: [t(i)], section: "demo", sectionTitle: "Demo", ms: 2400, tokens: 1800 * i } } });
	});
	return out;
}

/** Feed the scripted cycle (looping) through the live pipeline. Returns stop. Dev only: gated by `?kbdemo=1` in the page. */
export function startKbDemo(): () => void {
	if (process.env.NODE_ENV === "production") return () => undefined; // dev only
	let stopped = false;
	const timers: ReturnType<typeof setTimeout>[] = [];
	let cycle = 0;
	let seq = 0;
	const send = (event: Omit<ActivityEvent, "id" | "ts" | "v" | "pack" | "ttlMs">) => {
		const now = Date.now();
		const full = { v: 1, id: `demo-ev-${++seq}`, pack: "demo", ts: now, ttlMs: 60_000, ...event } as ActivityEvent;
		injectLiveAction({ type: "event", event: full, now });
	};
	const run = () => {
		if (stopped) return;
		const c = cycle++;
		injectLiveAction({ type: "event", event: { v: 1, id: `demo-online-${c}`, pack: "demo", ts: Date.now(), ttlMs: 120_000, actor: wolfActor, verb: "wolf-online" } as ActivityEvent, now: Date.now() });
		for (const s of demoCycle(c)) timers.push(setTimeout(() => !stopped && send(s.event), s.at));
		timers.push(setTimeout(run, 50_000));
	};
	run();
	return () => {
		stopped = true;
		timers.forEach(clearTimeout);
		injectLiveAction({ type: "event", event: { v: 1, id: `demo-offline-${++seq}`, pack: "demo", ts: Date.now(), ttlMs: 60_000, actor: wolfActor, verb: "wolf-offline" } as ActivityEvent, now: Date.now() });
		resetKbLife(); // the injected rows and the map's flights go with the demo
	};
}
