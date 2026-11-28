"use client";

/**
 * LiveGraphLayer: wires the live overlay to one graph renderer. Renders nothing but the small hover/tap card.
 *   - creates the LiveOverlay, attaches it to the renderer, applies `settings.live ?? defaults`;
 *   - follows the activity feed only while the layer is enabled (closes the stream otherwise);
 *   - merges the console's wolf roster (so offline wolves show dimmed at home) and tells the overlay which thread the floating chat is on;
 *   - hover (mouse) / tap (touch) shows a card; click on a thread or subagent opens its thread page; a click on an amber ring attaches the
 *     floating chat to that thread, where the pending card or questionnaire waits.
 * Threads cannot open in the viewer panel (it shows work items and KB entries only), so they open on their own page.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { pickComposerAnchor, trackSettle, SETTLE_FRAMES, SETTLE_MAX_FRAMES, type Anchor, type SettleState } from "@/src/core/graph/live/composer-anchor";
import { BellIcon, ExternalLinkIcon, XIcon } from "lucide-react";
import { threadHref } from "@/src/core";
import { kbdEventForAction, featureOfThread, type RosterThread } from "@/src/core";
import { talkToWolf } from "./live-talk";
import { useAttachedThread } from "@/components/chat-bar/attached-thread";
import type { GraphCanvasRenderer } from "../graph-canvas.ts";
import { acquireLiveFeed, getLiveSnapshot, onLiveAction, useLiveConnected } from "./live-store";
import { getKbHover, demoTargets, demoWorkId, onKbReset, startKbDemo, subscribeKbHover, watchKbPending } from "./kb-life-store";
import { LiveOverlay, liveSettingsOf, type OverlayCard, type OverlayHit } from "./live-overlay";

interface Shown { hit: OverlayHit; card: OverlayCard; pinned: boolean; width: number }

export function LiveGraphLayer({ renderer, settings }: { renderer: GraphCanvasRenderer | null; settings: unknown }) {
	const router = useRouter();
	const attachedApi = useAttachedThread();
	const live = liveSettingsOf(settings);
	const overlayRef = useRef<LiveOverlay | null>(null);
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const cardRef = useRef<HTMLDivElement | null>(null);
	const [shown, setShown] = useState<Shown | null>(null);
	const shownRef = useRef<Shown | null>(null);
	shownRef.current = shown;
	const liveRef = useRef(live);
	liveRef.current = live;
	const attachedRef = useRef(attachedApi);
	attachedRef.current = attachedApi;
	const routerRef = useRef(router);
	routerRef.current = router;

	const openThread = useCallback((wolf: string, threadId: string) => routerRef.current.push(threadHref(wolf, threadId)), []);
	const answer = useCallback((wolf: string, threadId: string) => {
		const a = attachedRef.current;
		if (a) a.attach({ wolf, threadId });
		else openThread(wolf, threadId);
	}, [openThread]);

	const runAction = useCallback((card: OverlayCard) => {
		const a = card.action;
		if (!a || !a.threadId) return;
		if (a.kind === "answer") answer(a.wolf, a.threadId);
		else openThread(a.wolf, a.threadId);
	}, [answer, openThread]);

	// The overlay lives as long as the renderer.
	useEffect(() => {
		if (!renderer) return;
		const o = new LiveOverlay(() => renderer.requestRedraw());
		o.configure(liveRef.current);
		overlayRef.current = o;
		const width = () => wrapRef.current?.clientWidth ?? 600;
		renderer.setOverlay(o, {
			onOverlayHover: (hit) => {
				if (shownRef.current?.pinned) return;
				setShown(hit ? { hit, card: o.cardFor(hit), pinned: false, width: width() } : null);
			},
			onOverlaySelect: (hit, pointerType) => {
				const touch = pointerType === "touch";
				if (hit.item.kind === "kb") return void setShown({ hit, card: o.cardFor(hit), pinned: false, width: width() }); // a filed entry's summary: a tap shows it, nothing to pin
				if (hit.ring) {
					const t = o.needsYouThread(hit.item.wolf, hit.item.threadId);
					if (t) return void answer(t.wolf, t.threadId);
				}
				// A click on a wolf's body is the handle for talking to it: point the floating chat at its home thread and focus it.
				if (!touch && hit.item.kind === "wolf") {
					const a = attachedRef.current;
					const did = talkToWolf(hit.item.wolf, { threads: a?.threads, attach: a ? (r) => a.attach(r) : undefined, focusComposer: () => window.dispatchEvent(new CustomEvent(kbdEventForAction("focus-chat-bar"))), navigate: (h) => routerRef.current.push(h) });
					if (did !== "none") return;
				}
				if (!touch && (hit.item.kind === "thread" || hit.item.kind === "feature" || hit.item.kind === "subagent") && hit.item.threadId) return void openThread(hit.item.wolf, hit.item.threadId);
				setShown({ hit, card: o.cardFor(hit), pinned: true, width: width() });
			},
		});
		o.start();
		return () => {
			renderer.setOverlay(null);
			o.stop();
			overlayRef.current = null;
			setShown(null);
		};
	}, [renderer, answer, openThread]);

	// The KB activity log's hover / selection: ring the wolf, node, flying topic or curator it names.
	useEffect(() => {
		if (!renderer) return;
		const apply = () => {
			const h = getKbHover();
			overlayRef.current?.setKbFocus(h && (h.topicId || h.curator) ? { topicId: h.topicId, curator: h.curator } : null);
			renderer.setOverlayHighlight(h && (h.wolf || h.target) ? { wolf: h.wolf, target: h.target, ...(h.sectionPath ? { sectionPath: h.sectionPath } : {}) } : null);
		};
		const off = subscribeKbHover(apply);
		const offReset = onKbReset(() => overlayRef.current?.resetKb());
		return () => {
			off();
			offReset();
			renderer.setOverlayHighlight(null);
		};
	}, [renderer]);

	// Private view: cards show kind and wolf only; a card already open is closed so no real title stays on screen.
	const priv = (settings as { privateView?: boolean } | null)?.privateView === true;
	useEffect(() => {
		overlayRef.current?.setPrivate(priv);
		setShown(null);
	}, [renderer, priv]);

	// Settings (live.enabled, intensity, trailSec, subagentFadeSec).
	useEffect(() => {
		overlayRef.current?.configure(live);
		if (!live.enabled) setShown(null);
	}, [renderer, live.enabled, live.intensity, live.trailSec, live.subagentFadeSec, live.motion, live.memory]); // eslint-disable-line react-hooks/exhaustive-deps

	// The feed: only while enabled; the stream closes when it is switched off or the graph goes away.
	useEffect(() => {
		if (!renderer || !live.enabled) return;
		const off = onLiveAction((a) => overlayRef.current?.dispatch(a));
		const release = acquireLiveFeed();
		overlayRef.current?.loadState(getLiveSnapshot().state);
		return () => {
			off();
			release();
		};
	}, [renderer, live.enabled]);

	// The curator's real queue: entries already pending when the graph opens orbit Home at once (and the list is re-read every 20 s). Not while the demo plays.
	const kbdemo = useSearchParams()?.get("kbdemo") === "1";
	const demoOn = kbdemo;
	useEffect(() => (renderer && live.enabled && live.memory && !demoOn ? watchKbPending((items) => overlayRef.current?.syncPending(items)) : undefined), [renderer, live.enabled, live.memory, demoOn]);

	// `?kbdemo=1` (dev builds only) plays the scripted memory life on /graph, as the first wolf on the map (else the attached thread's wolf, else a made-up one).
	const demoAsked = kbdemo && process.env.NODE_ENV !== "production";
	const demoWolf = Object.keys(getLiveSnapshot().state.wolves)[0] ?? attachedApi?.wolves[0]?.name ?? attachedApi?.attached?.wolf;
	useEffect(() => (renderer && demoAsked ? startKbDemo(demoWolf, () => { const g = renderer.demoGraph(); return demoTargets(g.edges, g.ids); }, (dom) => demoWorkId(renderer.demoGraph().ids, dom)) : undefined), [renderer, demoAsked, demoWolf]);

	// Every pack wolf, offline ones dimmed at home: only once the hub has answered, so with no hub the graph is exactly as before.
	const connected = useLiveConnected();
	const names = (attachedApi?.wolves ?? []).map((w) => w.name).join("\u0000");
	useEffect(() => {
		if (!renderer || !live.enabled || !names || !connected) return;
		overlayRef.current?.dispatch({ type: "roster", wolves: names.split("\u0000"), now: Date.now() });
	}, [renderer, live.enabled, names, connected]);

	// The wolves' own colours (the ones the sidebar uses) for their badges.
	const colorKey = (attachedApi?.wolves ?? []).map((w) => `${w.name}\u0001${w.color ?? ""}`).join("\u0000");
	useEffect(() => {
		if (!renderer) return;
		const map = new Map<string, string>();
		for (const part of colorKey ? colorKey.split("\u0000") : []) {
			const [name, color] = part.split("\u0001");
			if (name && color) map.set(name, color);
		}
		overlayRef.current?.setWolfColors(map);
	}, [renderer, colorKey]);

	// Open feature threads from the console's own thread roster: idle ones stay on the map (dimmed) until archived. Re-sent only when that list changes (no polling of its own).
	const rosterThreads = attachedApi?.threads;
	const featureKey = Object.entries(rosterThreads ?? {})
		.flatMap(([wolf, rows]) => (rows ?? []).filter((t) => featureOfThread(t.id) !== undefined).map((t) => `${wolf}\u0001${t.id}\u0001${t.closed ? 1 : 0}\u0001${t.title}`))
		.join("\u0000");
	useEffect(() => {
		if (!renderer || !live.enabled || !connected || !rosterThreads) return;
		const rows: RosterThread[] = [];
		for (const [wolf, list] of Object.entries(rosterThreads)) for (const t of list ?? []) rows.push({ wolf, id: t.id, title: t.title, closed: t.closed });
		overlayRef.current?.dispatch({ type: "threads", threads: rows, now: Date.now() });
	}, [renderer, live.enabled, connected, featureKey]); // eslint-disable-line react-hooks/exhaustive-deps

	// The you badge links to the floating chat's attached thread (the chat's target).
	const att = attachedApi?.attached ?? null;
	useEffect(() => {
		overlayRef.current?.setAttached(att ? { wolf: att.wolf, threadId: att.threadId } : null);
	}, [renderer, att?.wolf, att?.threadId]); // eslint-disable-line react-hooks/exhaustive-deps

	// The floating chat's rect (the you badge sits above it): measured on resize / scroll / size change / bar toggles, never per frame.
	// Absent or hidden (collapsed, phone with it closed): null, and the badge falls back to bottom-centre of the canvas.
	const minimized = attachedApi?.minimized ?? false;
	const pathname = usePathname();
	useEffect(() => {
		const wrap = wrapRef.current;
		if (!renderer || !wrap) return;
		let bar: Element | null = null;
		let ro: ResizeObserver | null = null;
		let last: Anchor | null = null; // a hidden / mid-mount element reads 0,0: keep the last good anchor instead (see pickComposerAnchor)
		let settle: SettleState = { anchor: null, still: 0 };
		let frames = 0;
		let loop = 0;
		const EMPTY = { left: 0, top: 0, width: 0, height: 0 };
		// The icon slides (left/top transition) and a ResizeObserver never fires for a move: after any trigger, re-read every frame until the anchor holds still.
		const tick = () => {
			loop = 0;
			read();
			settle = trackSettle(settle, last);
			if (settle.still < SETTLE_FRAMES && ++frames < SETTLE_MAX_FRAMES) loop = requestAnimationFrame(tick);
		};
		const kick = () => {
			frames = 0;
			settle = { anchor: null, still: 0 };
			if (!loop) loop = requestAnimationFrame(tick);
		};
		const read = () => {
			const el = document.querySelector('[data-testid="chat-bar"]');
			if (el !== bar) {
				ro?.disconnect();
				bar = el;
				if (el && typeof ResizeObserver !== "undefined") {
					ro ??= new ResizeObserver(() => measure());
					ro.observe(el);
				}
			}
			last = pickComposerAnchor(wrap.getBoundingClientRect(), [el && getComputedStyle(el).visibility === "hidden" ? EMPTY : el?.getBoundingClientRect()], last);
			overlayRef.current?.setComposerRect(last);
		};
		const measure = () => {
			kick();
			read();
		};
		ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => measure()) : null;
		ro?.observe(wrap);
		measure();
		window.addEventListener("resize", measure);
		window.addEventListener("scroll", measure, true);
		const vv = window.visualViewport; // the phone keyboard resizes / scrolls the visual viewport only
		vv?.addEventListener("resize", measure);
		vv?.addEventListener("scroll", measure);
		return () => {
			cancelAnimationFrame(loop);
			vv?.removeEventListener("resize", measure);
			vv?.removeEventListener("scroll", measure);
			ro?.disconnect();
			window.removeEventListener("resize", measure);
			window.removeEventListener("scroll", measure, true);
		};
	}, [renderer, att?.wolf, att?.threadId, minimized, pathname]);

	// A pinned card closes on any press outside it.
	useEffect(() => {
		if (!shown?.pinned) return;
		const onDown = (e: PointerEvent) => {
			if (cardRef.current && e.target instanceof Node && cardRef.current.contains(e.target)) return;
			setShown(null);
		};
		// Deferred one tick so the press that pinned the card does not close it.
		const t = setTimeout(() => window.addEventListener("pointerdown", onDown, true), 0);
		return () => {
			clearTimeout(t);
			window.removeEventListener("pointerdown", onDown, true);
		};
	}, [shown?.pinned]);

	const flip = shown ? shown.hit.sx > shown.width - 250 : false;
	return (
		<div ref={wrapRef} className="pointer-events-none absolute inset-0 z-[5] overflow-hidden">
			{shown && live.enabled && shown.hit.item.kind === "kb" && (
				<div
					role="tooltip"
					className="absolute max-w-[260px] truncate rounded-[10px] border border-border/50 bg-background/70 px-2.5 py-1.5 text-xs text-foreground shadow-md backdrop-blur-md"
					style={{ left: flip ? undefined : shown.hit.sx + 12, right: flip ? shown.width - shown.hit.sx + 12 : undefined, top: Math.max(8, shown.hit.sy - 12) }}
				>
					{shown.card.title}
				</div>
			)}
			{shown && live.enabled && shown.hit.item.kind !== "kb" && (
				<div
					ref={cardRef}
					className={`absolute w-56 rounded-[11px] border border-border/50 bg-background/70 p-2.5 text-xs shadow-lg backdrop-blur-md ${shown.pinned ? "pointer-events-auto" : ""}`}
					style={{ left: flip ? undefined : shown.hit.sx + 14, right: flip ? shown.width - shown.hit.sx + 14 : undefined, top: shown.hit.item.kind === "you" ? Math.max(8, shown.hit.sy - 96) : Math.max(8, shown.hit.sy - 14) }}
				>
					<div className="flex items-start justify-between gap-2">
						<div className="min-w-0 truncate text-[13px] font-medium text-foreground">{shown.card.title}</div>
						{shown.pinned && (
							<button type="button" aria-label="Close" className="-mr-1 -mt-0.5 rounded p-0.5 text-muted-foreground hover:text-foreground" onClick={() => setShown(null)}>
								<XIcon className="size-3.5" />
							</button>
						)}
					</div>
					{shown.card.lines.map((l, i) => (
						<div key={i} className="mt-0.5 truncate text-muted-foreground">{l}</div>
					))}
					{shown.pinned && shown.card.action && (
						<button
							type="button"
							className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-1 text-foreground hover:bg-muted/60"
							onClick={() => {
								runAction(shown.card);
								setShown(null);
							}}
						>
							{shown.card.action.kind === "answer" ? <BellIcon className="size-3.5 text-amber-500" /> : <ExternalLinkIcon className="size-3.5" />}
							{shown.card.action.label}
						</button>
					)}
				</div>
			)}
		</div>
	);
}
