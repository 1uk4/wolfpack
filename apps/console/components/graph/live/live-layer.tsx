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
import { useRouter } from "next/navigation";
import { BellIcon, ExternalLinkIcon, XIcon } from "lucide-react";
import { threadHref } from "@/src/core";
import { useAttachedThread } from "@/components/chat-bar/attached-thread";
import type { GraphCanvasRenderer } from "../graph-canvas.ts";
import { acquireLiveFeed, getLiveSnapshot, onLiveAction, useLiveActivity } from "./live-store";
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
				if (hit.ring) {
					const t = o.needsYouThread(hit.item.wolf, hit.item.threadId);
					if (t) return void answer(t.wolf, t.threadId);
				}
				if (!touch && (hit.item.kind === "thread" || hit.item.kind === "subagent") && hit.item.threadId) return void openThread(hit.item.wolf, hit.item.threadId);
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
	}, [renderer, live.enabled, live.intensity, live.trailSec, live.subagentFadeSec]); // eslint-disable-line react-hooks/exhaustive-deps

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

	// Every pack wolf, offline ones dimmed at home: only once the hub has answered, so with no hub the graph is exactly as before.
	const { connected } = useLiveActivity({ enabled: false });
	const names = (attachedApi?.wolves ?? []).map((w) => w.name).join("\u0000");
	useEffect(() => {
		if (!renderer || !live.enabled || !names || !connected) return;
		overlayRef.current?.dispatch({ type: "roster", wolves: names.split("\u0000"), now: Date.now() });
	}, [renderer, live.enabled, names, connected]);

	// The you-node also links to the floating chat's attached thread.
	const att = attachedApi?.attached ?? null;
	useEffect(() => {
		overlayRef.current?.setAttached(att ? { wolf: att.wolf, threadId: att.threadId } : null);
	}, [renderer, att?.wolf, att?.threadId]); // eslint-disable-line react-hooks/exhaustive-deps

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
			{shown && live.enabled && (
				<div
					ref={cardRef}
					className={`absolute w-56 rounded-[11px] border border-border/50 bg-background/70 p-2.5 text-xs shadow-lg backdrop-blur-md ${shown.pinned ? "pointer-events-auto" : ""}`}
					style={{ left: flip ? undefined : shown.hit.sx + 14, right: flip ? shown.width - shown.hit.sx + 14 : undefined, top: Math.max(8, shown.hit.sy - 14) }}
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
