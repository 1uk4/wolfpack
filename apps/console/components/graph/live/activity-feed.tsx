"use client";

/**
 * ActivityFeed: a narrow translucent feed at the bottom-left of the graph, one short line per live event (work-wolfpack-TVKc9Td).
 *   - newest at the bottom, ~8 lines visible (older fade), the expanded list scrolls through the last ~50 events;
 *   - collapses to an "Activity · N new" chip (N keeps rising while collapsed); collapsed state is per device (localStorage),
 *     collapsed by default on phones;
 *   - hover (tap on phone) rings the matching node via `overlay.setHighlight`; click attaches the floating chat to the line's thread
 *     (a needs-you line opens its questionnaire);
 *   - `private` shows only "<wolf> · <verb>" (the private view sets `settings.privateView`).
 * The relative times re-render on a 15 s timer, never per frame.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ActivityIcon, ChevronDownIcon } from "lucide-react";
import { threadHref } from "@/src/core";
import { useAttachedThread } from "@/components/chat-bar/attached-thread";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { feedCountReducer, formatFeed, relativeTime, type FeedLine } from "@/src/core";
import type { GraphCanvasRenderer } from "../graph-canvas.ts";
import { liveSettingsOf, type OverlayHighlight } from "./live-overlay";
import { useLiveActivity } from "./live-store";

const KEY = "wolfpack.graph.activityFeed.collapsed";
const VISIBLE = 8;

const isPhone = () =>
	typeof window !== "undefined" && ((typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches) || window.innerWidth < 700);

function initialCollapsed(): boolean {
	try {
		const v = localStorage.getItem(KEY);
		if (v === "1") return true;
		if (v === "0") return false;
	} catch {
		/* storage blocked: fall through to the default */
	}
	return isPhone();
}

const reducedMotion = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function ActivityFeed({ renderer, settings }: { renderer: GraphCanvasRenderer | null; settings: unknown }) {
	const live = liveSettingsOf(settings);
	const priv = (settings as { privateView?: boolean } | null)?.privateView === true;
	const router = useRouter();
	const attachApi = useAttachedThread();
	const { recent } = useLiveActivity({ enabled: live.enabled });
	const [count, dispatch] = useReducer(feedCountReducer, { collapsed: false, count: 0 });
	const [ready, setReady] = useState(false);
	const [now, setNow] = useState(() => Date.now());
	const [active, setActive] = useState<string | null>(null);
	const seen = useRef<string | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);

	// Read the remembered state after mount (SSR-safe).
	useEffect(() => {
		if (initialCollapsed()) dispatch({ type: "collapse" });
		setReady(true);
	}, []);

	const lines = useMemo(() => formatFeed(recent, { private: priv }), [recent, priv]);

	// Events since collapsing: everything after the last id seen.
	useEffect(() => {
		const last = recent[recent.length - 1]?.id ?? null;
		if (seen.current === null) {
			seen.current = last;
			return;
		}
		if (last === seen.current) return;
		const at = recent.findIndex((e) => e.id === seen.current);
		const fresh = formatFeed(at < 0 ? recent : recent.slice(at + 1), { private: priv }).length;
		seen.current = last;
		if (fresh > 0) dispatch({ type: "new", n: fresh });
	}, [recent, priv]);

	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 15_000);
		return () => clearInterval(t);
	}, []);

	// Newest at the bottom: keep the list scrolled down.
	useEffect(() => {
		const el = listRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [lines.length, count.collapsed]);

	const highlight = useCallback(
		(h: OverlayHighlight | null) => {
			renderer?.setOverlayHighlight(h);
		},
		[renderer],
	);
	useEffect(() => () => highlight(null), [highlight]);

	const toggle = (collapse: boolean) => {
		try {
			localStorage.setItem(KEY, collapse ? "1" : "0");
		} catch {
			/* ignore */
		}
		highlight(null);
		dispatch({ type: collapse ? "collapse" : "expand" });
	};

	// Touch has no leave: a highlight pinned by a tap clears after about 3 s or on the next press, so it can never keep the graph animating.
	const lastPointer = useRef<string>("mouse");
	const pinnedByTouch = useRef(false);
	useEffect(() => {
		if (active === null || !pinnedByTouch.current) return;
		const clear = () => {
			pinnedByTouch.current = false;
			setActive(null);
			highlight(null);
		};
		const timer = setTimeout(clear, 3000);
		// Deferred one tick so the press that pinned it does not clear it.
		const arm = setTimeout(() => window.addEventListener("pointerdown", clear, { once: true, capture: true }), 0);
		return () => {
			clearTimeout(timer);
			clearTimeout(arm);
			window.removeEventListener("pointerdown", clear, true);
		};
	}, [active, highlight]);

	const enter = (l: FeedLine) => {
		pinnedByTouch.current = lastPointer.current === "touch";
		setActive(l.key);
		highlight({ nodeId: l.nodeId, target: l.target, wolf: l.target || l.nodeId ? undefined : l.wolf === "you" ? undefined : l.wolf });
	};
	const leave = () => {
		setActive(null);
		highlight(null);
	};
	const open = (l: FeedLine) => {
		if (!l.thread) return;
		if (attachApi) attachApi.attach(l.thread);
		else router.push(threadHref(l.thread.wolf, l.thread.threadId));
	};

	if (!live.enabled || !ready || lines.length === 0) return null;
	const motion = reducedMotion() ? "" : "transition-[opacity,transform] duration-200 ease-[cubic-bezier(.34,1.56,.64,1)]";

	if (count.collapsed) {
		return (
			<div className="pointer-events-none absolute bottom-3 left-3 z-[6]">
				<button
					type="button"
					aria-label="Show activity feed"
					onClick={() => toggle(false)}
					className={`pointer-events-auto inline-flex items-center gap-1.5 rounded-[10px] border border-border/50 bg-background/70 px-2.5 py-1.5 text-xs text-muted-foreground shadow-sm backdrop-blur-md hover:text-foreground ${motion}`}
				>
					<ActivityIcon className="size-3.5" />
					<span>{count.count > 0 ? `Activity · ${count.count} new` : "Activity"}</span>
				</button>
			</div>
		);
	}

	const shown = lines.slice(-50);
	return (
		<div className="pointer-events-none absolute bottom-3 left-3 z-[6] w-[280px] max-w-[calc(100%-1.5rem)]">
			<div className={`pointer-events-auto overflow-hidden rounded-[12px] border border-border/50 bg-background/70 shadow-sm backdrop-blur-md ${motion}`}>
				<div className="flex items-center justify-between px-2.5 pt-1.5 text-[11px] text-muted-foreground">
					<span className="inline-flex items-center gap-1.5"><ActivityIcon className="size-3.5" />Activity</span>
					<Tooltip>
						<TooltipTrigger asChild>
							<button type="button" aria-label="Collapse activity feed" onClick={() => toggle(true)} className="rounded p-0.5 hover:text-foreground">
								<ChevronDownIcon className="size-3.5" />
							</button>
						</TooltipTrigger>
						<TooltipContent>Collapse</TooltipContent>
					</Tooltip>
				</div>
				<div ref={listRef} className="max-h-[168px] overflow-y-auto px-1.5 pb-1.5 pt-1" onMouseLeave={leave}>
					{shown.map((l, i) => {
						const fromEnd = shown.length - 1 - i;
						const fade = fromEnd >= VISIBLE ? 0.35 : 1 - Math.max(0, fromEnd - 3) * 0.14;
						const clickable = !!l.thread;
						return (
							<div
								key={l.key}
								role={clickable ? "button" : undefined}
								tabIndex={clickable ? 0 : undefined}
								onPointerDown={(e) => {
									lastPointer.current = e.pointerType;
								}}
								onMouseEnter={() => enter(l)}
								onClick={() => {
									enter(l);
									open(l);
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter") open(l);
								}}
								style={{ opacity: active === l.key ? 1 : fade }}
								className={`flex items-center gap-2 rounded-md px-1.5 py-[3px] text-[12px] leading-4 ${clickable ? "cursor-pointer" : ""} ${active === l.key ? "bg-muted/60" : ""} ${motion}`}
							>
								<span className="size-1.5 shrink-0 rounded-full" style={{ background: l.tone === "amber" ? "#f59e0b" : l.color }} />
								<span className={`min-w-0 flex-1 truncate ${l.tone === "amber" ? "text-amber-500" : "text-foreground"}`}>{l.text}</span>
								<span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">{relativeTime(now, l.time)}</span>
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}
