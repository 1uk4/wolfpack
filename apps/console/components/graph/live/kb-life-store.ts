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
	const events = useKbLiveEvents();
	return useMemo(() => foldEvents(events), [events]);
}

/** The raw memory events behind the rows (oldest first, with arrival ms). With enabled false it collects nothing and holds no feed reference. */
export function useKbLiveEvents(enabled = true): { event: ActivityEvent; at: number }[] {
	const [events, setEvents] = useState<{ event: ActivityEvent; at: number }[]>([]);
	useEffect(() => {
		if (!enabled) {
			setEvents((cur) => (cur.length ? [] : cur));
			return;
		}
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
	}, [enabled]);
	return events;
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
/** One demo cycle, then it repeats. */
const DEMO_LOOP_MS = 28_000;
const hubActor = { kind: "hub", title: "curator" } as const;

/** A place on the loaded map a demo entry is filed at (domain, the section above the entry, and an entry that is on the map). */
export interface DemoTarget { domain: string; section?: string; entryId: string }

/** Up to `max` filing targets from the loaded graph: for each domain node, the first entry found down the tree edges, with the section just above it. */
export function demoTargets(edges: readonly { from: string; to: string }[], ids: readonly string[], max = 5): DemoTarget[] {
	const adj = new Map<string, string[]>();
	for (const e of edges) {
		(adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
		(adj.get(e.to) ?? adj.set(e.to, []).get(e.to)!).push(e.from);
	}
	const out: DemoTarget[] = [];
	for (const dom of ids.filter((id) => id.startsWith("dom:"))) {
		const prev = new Map<string, string>([[dom, dom]]);
		const queue = [dom];
		for (let i = 0; i < queue.length; i++) {
			const cur = queue[i]!;
			if (cur.startsWith("ent:")) {
				const up = prev.get(cur)!;
				out.push({ domain: dom.slice(4), ...(up.startsWith("sec:") ? { section: up.slice(4) } : {}), entryId: cur.slice(4) });
				break;
			}
			for (const nb of adj.get(cur) ?? []) if (!prev.has(nb) && !nb.startsWith("work:") && !nb.startsWith("den:")) (prev.set(nb, cur), queue.push(nb));
		}
	}
	return out.slice(0, max);
}

/** One scripted cycle (ms offset, event). Real event shapes; `c` makes ids unique per cycle. `targets` are real places on the map (else made-up ids that are not on it). */
export function demoCycle(c: number, wolf: string = DEMO_WOLF, targets: readonly DemoTarget[] = []): { at: number; event: Omit<ActivityEvent, "id" | "ts" | "v" | "pack" | "ttlMs"> }[] {
	const t = (i: number) => `demo-${c}-t${i}`;
	const wolfBase = { actor: { kind: "wolf", wolf } as const };
	const out: { at: number; event: Omit<ActivityEvent, "id" | "ts" | "v" | "pack" | "ttlMs"> }[] = [];
	// Compact life (loops every DEMO_LOOP_MS): the buffer fills (0.3-1.8 s), consolidation births 5 topics at the wolf (2.5 s) that fly to the Home ring and orbit it,
	// they are promoted one by one (6-8.4 s) and the curator files each (from 9 s).
	[6000, 12000, 18000, 25000, 33000, 40000].forEach((count, i) => out.push({ at: 300 + i * 300, event: { ...wolfBase, verb: "memory-observe", detail: { count, capacity: 40000 } } }));
	const ids = [1, 2, 3, 4, 5];
	out.push({ at: 2500, event: { ...wolfBase, verb: "memory-consolidate", detail: { count: 14, topicIds: ids.map(t) } } });
	const place = (i: number): DemoTarget => targets.length ? targets[(i - 1) % targets.length]! : { domain: "wolfpack", section: "demo", entryId: `kb-demo-${i}` };
	ids.forEach((i) => out.push({ at: 3500 + (i - 1) * 600, event: { ...wolfBase, verb: "memory-promote", target: { kind: "domain", id: place(i).domain }, detail: { ref: `demo-c-${c}-${i}`, topicIds: [t(i)] } } }));
	const outcomes = ["create", "merge", "reject", "merge", "create"];
	ids.forEach((i) => {
		const base = 6500 + (i - 1) * 3000;
		const at = place(i);
		// the last create files an entry the map does not have yet: the nerve ends at its section with a temporary dot
		const entryId = i === 5 && targets.length ? `kb-demo-new-${c}` : at.entryId;
		out.push({ at: base, event: { actor: hubActor, verb: "curate-start", detail: { ref: t(i), topicIds: [t(i)] } } });
		const o = outcomes[i - 1]!;
		out.push({ at: base + 2200, event: { actor: hubActor, verb: "curate-done", ...(o === "reject" ? {} : { target: { kind: "kb-entry", id: entryId, domain: at.domain, title: o === "create" ? "Demo: new topic" : "Demo: merged topic" } }), detail: { outcome: o, ref: t(i), topicIds: [t(i)], ...(at.section ? { section: at.section } : {}), sectionTitle: "Demo", ms: 2200, tokens: 1800 * i } } });
	});
	return out;
}

/** Feed the scripted cycle (looping) through the live pipeline. Returns stop. Dev only: gated by `?kbdemo=1` in the page. */
export function startKbDemo(wolf: string = DEMO_WOLF, targetsOf?: () => DemoTarget[]): () => void {
	const wolfActor = { kind: "wolf", wolf } as const;
	const fake = wolf === DEMO_WOLF; // a made-up wolf is brought online and offline; a real one is left alone
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
		if (fake) injectLiveAction({ type: "event", event: { v: 1, id: `demo-online-${c}`, pack: "demo", ts: Date.now(), ttlMs: 120_000, actor: wolfActor, verb: "wolf-online" } as ActivityEvent, now: Date.now() });
		for (const s of demoCycle(c, wolf, targetsOf?.() ?? [])) timers.push(setTimeout(() => !stopped && send(s.event), s.at));
		timers.push(setTimeout(run, DEMO_LOOP_MS));
	};
	run();
	return () => {
		stopped = true;
		timers.forEach(clearTimeout);
		if (fake) injectLiveAction({ type: "event", event: { v: 1, id: `demo-offline-${++seq}`, pack: "demo", ts: Date.now(), ttlMs: 60_000, actor: wolfActor, verb: "wolf-offline" } as ActivityEvent, now: Date.now() });
		resetKbLife(); // the injected rows and the map's flights go with the demo
	};
}
