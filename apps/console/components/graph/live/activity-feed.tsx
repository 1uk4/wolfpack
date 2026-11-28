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
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ActivityIcon, XIcon } from "lucide-react";
import { threadHref } from "@/src/core";
import { useAttachedThread } from "@/components/chat-bar/attached-thread";
import { useWide } from "@/components/chat-bar/chat-bar";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { SEEN_KEY, activityPanelBox, loadSeenUpTo, replayTargetIds, saveSeenUpTo, unseenCount, formatFeed, formatPool, memoryRows, pendingNotice, poolBars, relativeTime, resolveTab, tabItems, tabsFor, wolfColor, type ActivityTab, type FeedLine, type MemoryRow } from "@/src/core";
import type { MemoryStatus } from "@wolfpack/client";
import { fetchMemoryStatus } from "@/components/kb/kb-client";
import { setKbHover, useKbLiveEvents } from "./kb-life-store";
import { CuratorLine } from "./curator-line";
import type { GraphCanvasRenderer } from "../graph-canvas.ts";
import { liveSettingsOf, type OverlayHighlight } from "./live-overlay";
import { useLiveActivity } from "./live-store";
import { OPEN_KEY, patchActivityPanel, toggleActivityPanel, useActivityPanel } from "./activity-panel-store";

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

/** localStorage, or null where there is none (SSR, tests, blocked storage): every access goes through this. */
function store(): Storage | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}

function initialOpen(): boolean {
	try {
		const v = localStorage.getItem(OPEN_KEY);
		if (v === "1") return true;
		if (v === "0") return false;
		const old = localStorage.getItem(KEY); // the earlier collapsed flag
		if (old === "1") return false;
		if (old === "0") return true;
	} catch {
		/* storage blocked: fall through to the default */
	}
	return !isPhone();
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
	const panel = useActivityPanel();
	const params = useSearchParams();
	const activityParam = params?.get("activity") ?? null;
	const ready = panel.ready;
	const [now, setNow] = useState(() => Date.now());
	const [active, setActive] = useState<string | null>(null);
	const seenUpTo = useRef(0);
	const listRef = useRef<HTMLDivElement | null>(null);

	// Read the remembered state after mount (SSR-safe).
	useEffect(() => {
		try {
			const s = store();
			setSavedTab(s?.getItem(TAB_KEY) ?? null);
			// First visit: everything already in the feed counts as seen.
			if (s && s.getItem(SEEN_KEY) === null) saveSeenUpTo(s, Date.now());
			seenUpTo.current = loadSeenUpTo(s);
		} catch {
			/* storage blocked: All */
		}
		patchActivityPanel({ open: initialOpen(), ready: true });
	}, []);

	// /kb-activity redirects to /graph?activity=kb: open the panel on the KB tab.
	useEffect(() => {
		if (activityParam === null) return;
		if (activityParam === "kb") setSavedTab("kb");
		toggleActivityPanel(true);
	}, [activityParam]);

	const lines = useMemo(() => formatFeed(recent, { private: priv }), [recent, priv]);
	const items = useMemo(() => tabItems(tab, lines, rows, memoryOn), [tab, lines, rows, memoryOn]);
	// A memory row is drawn as a feed line; its map focus (wolf, entry, topic dot) goes through the KB hover bus.
	const memFocus = useRef(new Map<string, MemoryRow["focus"]>());
	const pickTab = (t: ActivityTab) => {
		try {
			store()?.setItem(TAB_KEY, t);
		} catch {
			/* ignore */
		}
		setSavedTab(t);
		highlight(null);
	};

	// The toolbar badge: lines newer than the persisted seen-up-to mark while the panel is closed; open moves the mark to the newest line.
	useEffect(() => {
		if (!ready) return;
		if (panel.open) {
			const newest = lines.reduce((m, l) => Math.max(m, l.time), seenUpTo.current);
			if (newest > seenUpTo.current) {
				seenUpTo.current = newest;
				saveSeenUpTo(store(), newest);
			}
			patchActivityPanel({ unseen: 0 });
		} else {
			patchActivityPanel({ unseen: unseenCount(lines.map((l) => ({ at: l.time })), seenUpTo.current) });
		}
	}, [ready, panel.open, lines]);

	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 15_000);
		return () => clearInterval(t);
	}, []);

	// Newest at the bottom: keep the list scrolled down.
	useEffect(() => {
		const el = listRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [items.length, panel.open, tab]);

	const highlight = useCallback(
		(h: OverlayHighlight | null) => {
			renderer?.setOverlayHighlight(h);
			if (h === null) setKbHover(null);
		},
		[renderer],
	);
	useEffect(() => () => highlight(null), [highlight]);

	const close = () => {
		highlight(null);
		toggleActivityPanel(false);
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
		// Replay: fly the camera to the filed entry (else its deepest section on the map, else the domain) and ring its tree path.
		if (renderer && l.target?.kind === "kb-entry") {
			const path = memFocus.current.get(l.key)?.sectionPath;
			const cands = [`ent:${l.target.id}`, ...(path ?? []).map((s) => `sec:${s}`), ...(l.target.domain ? [`dom:${l.target.domain}`] : [])];
			const ids = replayTargetIds(renderer.nodesOnMap(cands), l.target, path);
			if (ids.length > 0) renderer.focusOn(ids, 3, !reducedMotion());
		}
		if (!l.thread) return;
		if (attachApi) attachApi.attach(l.thread);
		else router.push(threadHref(l.thread.wolf, l.thread.threadId));
	};

	// Row handlers go through a ref so memoised rows keep a stable prop and skip re-rendering on every feed update.
	const handlersRef = useRef({ enter, leave, open, pointer: (t: string) => void (lastPointer.current = t) });
	handlersRef.current = { enter, leave, open, pointer: (t: string) => void (lastPointer.current = t) };

	// The toolbar's Activity button opens it; closed, nothing is drawn.
	if (!live.enabled || !ready || !connected || !panel.open) return null;
	const motion = reducedMotion() ? "" : "transition-[opacity,transform] duration-200 ease-[cubic-bezier(.34,1.56,.64,1)]";

	const box = activityPanelBox(!wide);
	const sheet = box.kind === "sheet";
	const tap = sheet ? "min-h-11 min-w-11 justify-center" : "";

	const shown: FeedLine[] = items.slice(-50).map((it) => {
		if (it.kind === "line") return it.line;
		memFocus.current.set(it.key, it.row.focus);
		const wolf = it.row.wolf ?? "wolf";
		return { key: it.key, wolf, color: wolfColor(wolf), text: it.row.wolf && !it.row.text.startsWith(wolf) ? `${wolf} · ${it.row.text}` : it.row.text, time: it.row.at, tone: "normal" };
	});
	const tabs = tabsFor(memoryOn);
	return (
		<div style={{ bottom: `calc(${box.bottom})` }} className={`pointer-events-none absolute z-[6] ${sheet ? "inset-x-2" : "left-3 w-[280px] max-w-[calc(100%-1.5rem)]"}`}>
			<div role={sheet ? "dialog" : undefined} aria-label={sheet ? "Activity" : undefined} className={`pointer-events-auto overflow-hidden border border-border/50 bg-background/70 shadow-sm backdrop-blur-md ${sheet ? "rounded-[14px]" : "rounded-[12px]"} ${motion}`}>
				{sheet && (
					<button type="button" aria-label="Close activity" onClick={close} className="flex h-6 w-full items-center justify-center">
						<span className="h-1 w-9 rounded-full bg-muted-foreground/40" />
					</button>
				)}
				<div className={`flex items-center justify-between px-2.5 text-[11px] text-muted-foreground ${sheet ? "text-[13px]" : "pt-1.5"}`}>
					<span className="inline-flex items-center gap-1" role="tablist" aria-label="Activity">
						<ActivityIcon className="mr-0.5 size-3.5" />
						{tabs.map((t) => (
							<button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => pickTab(t)} className={`inline-flex items-center rounded px-1.5 py-0.5 ${tap} ${tab === t ? "bg-muted/70 text-foreground" : "hover:text-foreground"}`}>{TAB_LABEL[t]}</button>
						))}
					</span>
					<TooltipProvider>
					<Tooltip>
						<TooltipTrigger asChild>
							<button type="button" aria-label="Close activity" onClick={close} className={`inline-flex items-center rounded p-0.5 hover:text-foreground ${tap}`}>
								<XIcon className="size-3.5" />
							</button>
						</TooltipTrigger>
						<TooltipContent>Close</TooltipContent>
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
				<div ref={listRef} className={`overflow-y-auto px-1.5 pb-1.5 pt-1 ${sheet ? "max-h-[40vh]" : "max-h-[168px]"}`} onMouseLeave={leave}>
					{shown.length === 0 && <div className="px-1.5 py-1 text-[12px] text-muted-foreground">Quiet</div>}
					{shown.map((l, i) => {
						const fromEnd = shown.length - 1 - i;
						const fade = fromEnd >= VISIBLE ? 0.35 : 1 - Math.max(0, fromEnd - 3) * 0.14;
						return <FeedRow key={l.key} l={l} opacity={active === l.key ? 1 : fade} on={active === l.key} rel={relativeTime(now, l.time)} motion={motion} tall={sheet} handlers={handlersRef} />;
					})}
				</div>
			</div>
		</div>
	);
}

interface RowHandlers { enter(l: FeedLine): void; leave(): void; open(l: FeedLine): void; pointer(type: string): void }

/** One feed line, memoised by its key and primitive props: a new event re-renders only the rows that changed. */
const FeedRow = memo(function FeedRow({ l, opacity, on, rel, motion, tall, handlers }: { l: FeedLine; opacity: number; on: boolean; rel: string; motion: string; tall: boolean; handlers: { current: RowHandlers } }) {
	const clickable = !!l.thread || l.target?.kind === "kb-entry";
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
			className={`flex items-center gap-2 rounded-md px-1.5 py-[3px] ${tall ? "min-h-11" : ""} text-[12px] leading-4 ${clickable ? "cursor-pointer" : ""} ${on ? "bg-muted/60" : ""} ${motion}`}
		>
			<span className="size-1.5 shrink-0 rounded-full" style={{ background: l.tone === "amber" ? "#f59e0b" : l.color }} />
			<span className={`min-w-0 flex-1 truncate ${l.tone === "amber" ? "text-amber-500" : "text-foreground"}`}>{l.text}</span>
			<span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">{rel}</span>
		</div>
	);
}, (a, b) => a.l.key === b.l.key && a.l.text === b.l.text && a.l.time === b.l.time && a.l.tone === b.l.tone && a.opacity === b.opacity && a.on === b.on && a.rel === b.rel && a.motion === b.motion && a.tall === b.tall);
