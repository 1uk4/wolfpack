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
import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ActivityIcon, ChevronDownIcon } from "lucide-react";
import { threadHref } from "@/src/core";
import { useAttachedThread } from "@/components/chat-bar/attached-thread";
import { useWide } from "@/components/chat-bar/chat-bar";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { feedCountReducer, feedPanelBottom, feedPillLabel, formatFeed, formatPool, memoryRows, pendingNotice, poolBars, relativeTime, resolveTab, tabItems, tabsFor, wolfColor, type ActivityTab, type FeedLine, type MemoryRow } from "@/src/core";
import type { MemoryStatus } from "@wolfpack/client";
import { fetchMemoryStatus } from "@/components/kb/kb-client";
import { setKbHover, useKbLiveEvents } from "./kb-life-store";
import { CuratorLine } from "./curator-line";
import type { GraphCanvasRenderer } from "../graph-canvas.ts";
import { liveSettingsOf, type OverlayHighlight } from "./live-overlay";
import { useLiveActivity } from "./live-store";

const KEY = "wolfpack.graph.activityFeed.collapsed";
const TAB_KEY = "wolfpack.graph.activityFeed.tab";
const TAB_LABEL: Record<ActivityTab, string> = { all: "All", kb: "KB", memory: "Memory" };
const PENDING_POLL_MS = 30_000;

/** One wolf's stuck-saves summary, refreshed every 30 s while the Memory tab is open. An older wolfd (no field) or an unreachable wolf shows nothing. */
function usePending(wolves: readonly string[], active: boolean): Record<string, MemoryStatus["pending"]> {
	const [pending, setPending] = useState<Record<string, MemoryStatus["pending"]>>({});
	const names = wolves.join("\n");
	useEffect(() => {
		if (!active || !names) return;
		let stop = false;
		const poll = () => {
			for (const w of names.split("\n")) {
				void fetchMemoryStatus(w, undefined, 0).then((r) => {
					if (!stop && r.ok) setPending((cur) => ({ ...cur, [w]: r.data.pending }));
				});
			}
		};
		poll();
		const t = setInterval(poll, PENDING_POLL_MS);
		return () => {
			stop = true;
			clearInterval(t);
		};
	}, [names, active]);
	return pending;
}
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
	const wide = useWide();
	const attachApi = useAttachedThread();
	const { recent, connected, state } = useLiveActivity({ enabled: live.enabled });
	const memoryOn = live.memory;
	const events = useKbLiveEvents(live.enabled && memoryOn);
	const rows = useMemo(() => memoryRows(events), [events]);
	const bars = useMemo(() => poolBars(events), [events]);
	const [savedTab, setSavedTab] = useState<string | null>(null);
	const tab = resolveTab(savedTab, memoryOn);
	const wolfNames = useMemo(() => [...new Set([...Object.keys(state.wolves), ...Object.keys(bars)])].sort(), [state.wolves, bars]);
	const pending = usePending(wolfNames, memoryOn && tab === "memory");
	const [count, dispatch] = useReducer(feedCountReducer, { collapsed: false, count: 0 });
	const [ready, setReady] = useState(false);
	const [now, setNow] = useState(() => Date.now());
	const [active, setActive] = useState<string | null>(null);
	const seen = useRef<string | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);

	// Read the remembered state after mount (SSR-safe).
	useEffect(() => {
		if (initialCollapsed()) dispatch({ type: "collapse" });
		try {
			setSavedTab(localStorage.getItem(TAB_KEY));
		} catch {
			/* storage blocked: All */
		}
		setReady(true);
	}, []);

	const lines = useMemo(() => formatFeed(recent, { private: priv }), [recent, priv]);
	const items = useMemo(() => tabItems(tab, lines, rows, memoryOn), [tab, lines, rows, memoryOn]);
	// A memory row is drawn as a feed line; its map focus (wolf, entry, topic dot) goes through the KB hover bus.
	const memFocus = useRef(new Map<string, MemoryRow["focus"]>());
	const pickTab = (t: ActivityTab) => {
		try {
			localStorage.setItem(TAB_KEY, t);
		} catch {
			/* ignore */
		}
		setSavedTab(t);
		highlight(null);
	};

	// Events since collapsing: everything after the last id seen.
	useEffect(() => {
		const last = recent[recent.length - 1]?.id ?? null;
		if (seen.current === null) {
			seen.current = last;
			return;
		}
		if (last === seen.current) return;
		const at = recent.findIndex((e) => e.id === seen.current);
		const prev = seen.current;
		seen.current = last;
		if (!count.collapsed) return; // the count only matters while collapsed: no second formatFeed pass otherwise
		const fresh = formatFeed(prev === null || at < 0 ? recent : recent.slice(at + 1), { private: priv }).length;
		if (fresh > 0) dispatch({ type: "new", n: fresh });
	}, [recent, priv, count.collapsed]);

	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 15_000);
		return () => clearInterval(t);
	}, []);

	// Newest at the bottom: keep the list scrolled down.
	useEffect(() => {
		const el = listRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [items.length, count.collapsed, tab]);

	const highlight = useCallback(
		(h: OverlayHighlight | null) => {
			renderer?.setOverlayHighlight(h);
			if (h === null) setKbHover(null);
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
		const mf = memFocus.current.get(l.key);
		if (mf) return void setKbHover(mf);
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

	// Row handlers go through a ref so memoised rows keep a stable prop and skip re-rendering on every feed update.
	const handlersRef = useRef({ enter, leave, open, pointer: (t: string) => void (lastPointer.current = t) });
	handlersRef.current = { enter, leave, open, pointer: (t: string) => void (lastPointer.current = t) };

	// Once the hub has answered, always show at least the collapsed pill ("Quiet" when nothing is going on).
	if (!live.enabled || !ready || !connected) return null;
	const motion = reducedMotion() ? "" : "transition-[opacity,transform] duration-200 ease-[cubic-bezier(.34,1.56,.64,1)]";

	if (count.collapsed || (lines.length === 0 && rows.length === 0 && !(memoryOn && tab === "memory" && wolfNames.length > 0))) {
		return (
			<div className="pointer-events-none absolute bottom-[calc(var(--chat-bar-top,0px)+12px)] left-3 z-[6]">
				<button
					type="button"
					aria-label="Show activity feed"
					onClick={() => toggle(false)}
					className={`pointer-events-auto inline-flex items-center gap-1.5 rounded-[10px] border border-border/50 bg-background/70 px-2.5 py-1.5 text-xs text-muted-foreground shadow-sm backdrop-blur-md hover:text-foreground ${motion}`}
				>
					<ActivityIcon className="size-3.5" />
					<span>{feedPillLabel(count.count, lines.length)}</span>
				</button>
			</div>
		);
	}

	const shown: FeedLine[] = items.slice(-50).map((it) => {
		if (it.kind === "line") return it.line;
		memFocus.current.set(it.key, it.row.focus);
		const wolf = it.row.wolf ?? "wolf";
		return { key: it.key, wolf, color: wolfColor(wolf), text: it.row.wolf && !it.row.text.startsWith(wolf) ? `${wolf} · ${it.row.text}` : it.row.text, time: it.row.at, tone: "normal" };
	});
	const tabs = tabsFor(memoryOn);
	return (
		<div style={{ bottom: feedPanelBottom(!wide) }} className="pointer-events-none absolute left-3 z-[6] w-[280px] max-w-[calc(100%-1.5rem)]">
			<div className={`pointer-events-auto overflow-hidden rounded-[12px] border border-border/50 bg-background/70 shadow-sm backdrop-blur-md ${motion}`}>
				<div className="flex items-center justify-between px-2.5 pt-1.5 text-[11px] text-muted-foreground">
					<span className="inline-flex items-center gap-1" role="tablist" aria-label="Activity">
						<ActivityIcon className="mr-0.5 size-3.5" />
						{tabs.map((t) => (
							<button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => pickTab(t)} className={`rounded px-1.5 py-0.5 ${tab === t ? "bg-muted/70 text-foreground" : "hover:text-foreground"}`}>{TAB_LABEL[t]}</button>
						))}
					</span>
					<TooltipProvider>
					<Tooltip>
						<TooltipTrigger asChild>
							<button type="button" aria-label="Collapse activity feed" onClick={() => toggle(true)} className="rounded p-0.5 hover:text-foreground">
								<ChevronDownIcon className="size-3.5" />
							</button>
						</TooltipTrigger>
						<TooltipContent>Collapse</TooltipContent>
					</Tooltip>
					</TooltipProvider>
				</div>
				{memoryOn && tab === "memory" && <CuratorLine events={events} />}
				{memoryOn && tab === "memory" && wolfNames.length > 0 && (
					<div className="space-y-1 px-2.5 pt-1.5">
						{wolfNames.map((w) => {
							const bar = bars[w];
							const warn = pendingNotice(pending[w]);
							return (
								<div key={w} className="text-[11px] leading-4">
									<div className="flex items-center gap-2">
										<span className="w-14 shrink-0 truncate text-foreground">{w}</span>
										<span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted/60">
											<span className="block h-full rounded-full" style={{ width: `${bar ? Math.min(100, (bar.count / Math.max(1, bar.capacity)) * 100) : 0}%`, background: wolfColor(w) }} />
										</span>
										<span className="shrink-0 tabular-nums text-muted-foreground">{formatPool(bar)}</span>
									</div>
									{warn && <div title={warn.title} className="truncate pl-16 text-amber-500">{warn.text}</div>}
								</div>
							);
						})}
					</div>
				)}
				<div ref={listRef} className="max-h-[168px] overflow-y-auto px-1.5 pb-1.5 pt-1" onMouseLeave={leave}>
					{shown.length === 0 && <div className="px-1.5 py-1 text-[12px] text-muted-foreground">Quiet</div>}
					{shown.map((l, i) => {
						const fromEnd = shown.length - 1 - i;
						const fade = fromEnd >= VISIBLE ? 0.35 : 1 - Math.max(0, fromEnd - 3) * 0.14;
						return <FeedRow key={l.key} l={l} opacity={active === l.key ? 1 : fade} on={active === l.key} rel={relativeTime(now, l.time)} motion={motion} handlers={handlersRef} />;
					})}
				</div>
			</div>
		</div>
	);
}

interface RowHandlers { enter(l: FeedLine): void; leave(): void; open(l: FeedLine): void; pointer(type: string): void }

/** One feed line, memoised by its key and primitive props: a new event re-renders only the rows that changed. */
const FeedRow = memo(function FeedRow({ l, opacity, on, rel, motion, handlers }: { l: FeedLine; opacity: number; on: boolean; rel: string; motion: string; handlers: { current: RowHandlers } }) {
	const clickable = !!l.thread;
	return (
		<div
			role={clickable ? "button" : undefined}
			tabIndex={clickable ? 0 : undefined}
			onPointerDown={(e) => handlers.current.pointer(e.pointerType)}
			onMouseEnter={() => handlers.current.enter(l)}
			onClick={() => {
				handlers.current.enter(l);
				handlers.current.open(l);
			}}
			onKeyDown={(e) => {
				if (e.key === "Enter") handlers.current.open(l);
			}}
			style={{ opacity }}
			className={`flex items-center gap-2 rounded-md px-1.5 py-[3px] text-[12px] leading-4 ${clickable ? "cursor-pointer" : ""} ${on ? "bg-muted/60" : ""} ${motion}`}
		>
			<span className="size-1.5 shrink-0 rounded-full" style={{ background: l.tone === "amber" ? "#f59e0b" : l.color }} />
			<span className={`min-w-0 flex-1 truncate ${l.tone === "amber" ? "text-amber-500" : "text-foreground"}`}>{l.text}</span>
			<span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">{rel}</span>
		</div>
	);
}, (a, b) => a.l.key === b.l.key && a.l.text === b.l.text && a.l.time === b.l.time && a.l.tone === b.l.tone && a.opacity === b.opacity && a.on === b.on && a.rel === b.rel && a.motion === b.motion);
