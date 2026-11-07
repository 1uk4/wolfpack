"use client";

/**
 * THE FLOATING CHAT BAR: one pill, mounted once in the root layout, talking to the ONE thread the
 * AttachedThreadProvider holds, whatever page is open. It has NO stream and mounts no session model: it posts to the
 * thread's submit route (steering when a turn runs), aborts through the abort route, and shows "working…" from the
 * events channel (see attached-thread.tsx). Drafts share the thread page's key.
 *
 * On the attached thread's own page the bar is hidden (the page composer takes over; Cmd/Ctrl+J focuses it). Only the
 * chip, the switcher and the shortcuts are eager; the input half (chat-bar-composer.tsx) loads on first expand.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { ChevronDownIcon, MessageSquareIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { BrailleSpinner } from "@/components/braille-spinner";
import { useAttachedThread } from "@/components/attached-thread";
import { onOwnThreadPage } from "@/components/chat-bar-io";
import { useThreadColor } from "@/components/use-thread-color";
import { useBarCards } from "@/components/chat-bar-cards";
import { useOptionalServerEvent } from "@/components/server-events";
import { attachable, kbdEventForAction, type AttachedRef, type BarThread, type SwitcherGroup } from "@/src/core";

export { abortThread, onOwnThreadPage, submitToThread, whenBusyFor } from "@/components/chat-bar-io";

const loadComposer = () => import("@/components/chat-bar-composer");
const BarComposer = dynamic(loadComposer, { ssr: false });
const BarCardSurface = dynamic(() => import("@/components/bar-card-surface").then((m) => m.BarCardSurface), { ssr: false });

/** Pages that scroll: the open bar reserves room under their content. Full-height screens (graph, chat) are left alone. */
const SCROLLING = /^\/(kb|work|kb-activity|pipeline|settings)(\/|$)|^\/wolf\/[^/]+$/;

/** The bar's md+ only for now (the phone layout is a later task). */
function useWide(): boolean {
	const [wide, setWide] = useState(true);
	useEffect(() => {
		if (typeof window.matchMedia !== "function") return;
		const mq = window.matchMedia("(min-width: 768px)");
		const on = () => setWide(mq.matches);
		on();
		mq.addEventListener?.("change", on);
		return () => mq.removeEventListener?.("change", on);
	}, []);
	return wide;
}

export function ChatBar() {
	const api = useAttachedThread();
	const pathname = usePathname();
	const wide = useWide();
	const attached = api?.attached ?? null;
	const own = onOwnThreadPage(pathname, attached);
	const [switcher, setSwitcher] = useState(false);
	const chipRef = useRef<HTMLButtonElement | null>(null);
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const minimized = api?.minimized ?? false;
	const full = !!attached && wide && !own && !minimized;
	const scrolls = !!pathname && SCROLLING.test(pathname);

	// Shortcuts: the dispatcher hands over the KeyboardEvent; the browser's own key (Cmd+J = downloads) is swallowed only
	// when the bar (or, on its own thread's page, the page composer) actually answers.
	const live = useRef({ attached, own, wide, minimized, setMinimized: api?.setMinimized });
	live.current = { attached, own, wide, minimized, setMinimized: api?.setMinimized };
	useEffect(() => {
		const focusInput = (n = 0) => {
			const el = document.querySelector('[data-testid="chat-bar"] textarea') as HTMLTextAreaElement | null;
			if (el) el.focus();
			else if (n < 30) requestAnimationFrame(() => focusInput(n + 1));
		};
		const onFocus = (e: Event) => {
			const kev = (e as CustomEvent<{ event?: KeyboardEvent }>).detail?.event;
			const l = live.current;
			if (l.own) {
				const page = document.querySelector('[data-testid="composer"] textarea') as HTMLTextAreaElement | null;
				if (!page) return;
				kev?.preventDefault();
				page.focus();
				return;
			}
			if (!l.attached || !l.wide) return;
			kev?.preventDefault();
			if (l.minimized) l.setMinimized?.(false);
			focusInput();
		};
		const onSwitcher = (e: Event) => {
			const kev = (e as CustomEvent<{ event?: KeyboardEvent }>).detail?.event;
			const l = live.current;
			if (!l.attached || !l.wide || l.own) return;
			kev?.preventDefault();
			if (l.minimized) l.setMinimized?.(false);
			setSwitcher(true);
		};
		window.addEventListener(kbdEventForAction("focus-chat-bar"), onFocus);
		window.addEventListener(kbdEventForAction("chat-bar-switcher"), onSwitcher);
		return () => {
			window.removeEventListener(kbdEventForAction("focus-chat-bar"), onFocus);
			window.removeEventListener(kbdEventForAction("chat-bar-switcher"), onSwitcher);
		};
	}, []);

	// Scroll room: while the full bar floats over a scrolling page, main reserves its height (--chat-bar-reserve, globals.css).
	useEffect(() => {
		const root = document.documentElement;
		if (!full || !scrolls || !wrapRef.current) {
			root.style.removeProperty("--chat-bar-reserve");
			return;
		}
		const el = wrapRef.current;
		const set = () => root.style.setProperty("--chat-bar-reserve", `${Math.ceil(el.getBoundingClientRect().height) + 32}px`);
		set();
		const ro = new ResizeObserver(set);
		ro.observe(el);
		return () => {
			ro.disconnect();
			root.style.removeProperty("--chat-bar-reserve");
		};
	}, [full, scrolls, attached?.wolf, attached?.threadId]);

	// Focus returns to the chip; after a pick the re-keyed Bar has a NEW chip, so the focus waits for it.
	const refocus = useRef(false);
	const closeSwitcher = useCallback(() => {
		setSwitcher(false);
		refocus.current = true;
		chipRef.current?.focus();
	}, []);
	useEffect(() => {
		if (!refocus.current) return;
		refocus.current = false;
		chipRef.current?.focus();
	}, [attached?.wolf, attached?.threadId]);

	// A hidden bar closes its switcher (it must not reappear on return); and the input chunk preloads when idle,
	// so a cold Cmd+J finds the textarea.
	const shown = !!attached && wide && !own;
	useEffect(() => {
		if (!shown) setSwitcher(false);
	}, [shown]);
	useEffect(() => {
		if (!attached || !wide) return;
		const idle = (window as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
		if (idle) idle(() => void loadComposer());
		else setTimeout(() => void loadComposer(), 200);
	}, [!!attached, wide]);

	if (!api || !attached || !wide || own) return null;
	return <Bar key={`${attached.wolf}/${attached.threadId}`} target={attached} wrapRef={wrapRef} chipRef={chipRef} switcher={switcher} setSwitcher={setSwitcher} closeSwitcher={closeSwitcher} />;
}

function Bar({ target, wrapRef, chipRef, switcher, setSwitcher, closeSwitcher }: {
	target: AttachedRef;
	wrapRef: React.RefObject<HTMLDivElement | null>;
	chipRef: React.RefObject<HTMLButtonElement | null>;
	switcher: boolean;
	setSwitcher: (v: boolean | ((s: boolean) => boolean)) => void;
	closeSwitcher: () => void;
}) {
	const api = useAttachedThread()!;
	const { minimized, setMinimized, working, attachedThread, groups, note } = api;
	const all = useMemo(() => Object.values(api.threads).flatMap((l) => l ?? []), [api.threads]);
	const color = useThreadColor({ id: target.threadId, ...(attachedThread?.settings ? { settings: attachedThread.settings } : {}), ...(attachedThread?.parentThreadId ? { parentThreadId: attachedThread.parentThreadId } : {}) }, all).hex;
	const cards = useBarCards(target, working);
	const raised = useRaisedAt(api.attached !== null);
	const waiting = useMemo(() => oldestFirst(waitingElsewhere(api.threads, target), raised), [api.threads, target, raised]);
	const title = attachedThread ? (attachedThread.kind === "home" ? target.wolf : attachedThread.title) : target.slug;

	const badge = waiting.length > 0 ? <NeedsYouBadge waiting={waiting} all={all} /> : null;
	const chip = (
		<button
			ref={chipRef}
			type="button"
			data-testid="chat-bar-chip"
			aria-haspopup="dialog"
			aria-expanded={switcher}
			onClick={() => (minimized ? setMinimized(false) : setSwitcher((s) => !s))}
			className="flex max-w-56 items-center gap-1.5 rounded-full px-2.5 py-1 font-ui text-xs hover:bg-accent"
			title={`${target.wolf} · ${title}`}
		>
			<span data-testid="chat-bar-dot" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
			<span className="truncate">{title}</span>
			<span className="text-muted-foreground">{target.wolf}</span>
			{working && <BrailleSpinner />}
		</button>
	);

	if (minimized) {
		return (
			<div data-testid="chat-bar" data-state="minimized" className="fixed bottom-3 left-1/2 z-30 -translate-x-1/2">
				<div className="relative rounded-full border bg-card shadow-md" style={{ borderColor: color }}>
					<div className="flex items-center">
						{chip}
						{badge}
						<button type="button" aria-label="Expand chat bar" data-testid="chat-bar-expand" onClick={() => setMinimized(false)} className="mr-1 rounded-full p-1 text-muted-foreground hover:bg-accent">
							<MessageSquareIcon className="size-3.5" />
						</button>
					</div>
					{switcher && <Switcher groups={groups} current={target} onClose={closeSwitcher} />}
				</div>
			</div>
		);
	}

	return (
		<div ref={wrapRef} data-testid="chat-bar" data-state="open" className="fixed bottom-3 left-1/2 z-30 w-[min(42rem,calc(100vw-2rem))] -translate-x-1/2">
			{/* Card surface slot (PtJkpk6): the thread's pending question/brief cards and the last-reply peek mount here, above the input. */}
			<div data-slot="chat-bar-card-surface" data-testid="chat-bar-card-surface" className="mb-2 empty:hidden">
				{(cards.pending.length > 0 || cards.superseded.length > 0 || cards.peek || cards.error) && <BarCardSurface key={`${target.wolf}:${target.threadId}`} target={target} cards={cards} />}
			</div>
			<div className="relative rounded-2xl border bg-card shadow-lg" style={{ borderColor: color }}>
				<div className="flex items-center gap-1 px-1.5 pt-1">
					{chip}
					{badge}
					{working && <span data-testid="chat-bar-working" className="font-ui text-xs text-muted-foreground">working…</span>}
					{note && !working && <span data-testid="chat-bar-note" className="truncate font-ui text-xs text-muted-foreground">{note}</span>}
					<button type="button" aria-label="Minimize chat bar" data-testid="chat-bar-minimize" onClick={() => setMinimized(true)} className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-accent">
						<ChevronDownIcon className="size-4" />
					</button>
				</div>
				<BarComposer target={target} title={title} cardOpen={cards.pending.length > 0} onReplied={cards.replied} />
				{switcher && <Switcher groups={groups} current={target} onClose={closeSwitcher} />}
			</div>
		</div>
	);
}

/** Threads on any wolf waiting for the owner, other than the attached one (home / feature threads only, no subagents). List order; `oldestFirst` re-sorts it by when each thread's oldest card was raised. */
export function waitingElsewhere(threads: Record<string, readonly BarThread[] | undefined>, current: Pick<AttachedRef, "wolf" | "threadId">): (BarThread & { wolf: string })[] {
	return Object.entries(threads).flatMap(([wolf, list]) =>
		(list ?? []).filter((t) => t.status === "needs-you" && !(wolf === current.wolf && t.id === current.threadId) && attachable(t)).map((t) => ({ ...t, wolf })),
	);
}

/** `wolf\nthreadId` → raisedAt (ms) of that thread's oldest pending card, from GET /api/needs-you. Empty when the route fails (list order then). */
export type RaisedAt = ReadonlyMap<string, number>;

/** Waiting threads sorted by their oldest card's raisedAt, oldest first; threads with no known time keep list order after the known ones. Stable. */
export function oldestFirst<T extends { id: string; wolf: string }>(list: readonly T[], raised: RaisedAt): T[] {
	const at = (t: T) => raised.get(`${t.wolf}\n${t.id}`) ?? Infinity;
	return list.map((t, i) => ({ t, i })).sort((a, b) => (at(a.t) === at(b.t) ? a.i - b.i : at(a.t) < at(b.t) ? -1 : 1)).map((x) => x.t);
}

/** Fetches /api/needs-you once and again on every needs-you-changed (no polling). */
function useRaisedAt(enabled: boolean): RaisedAt {
	const [raised, setRaised] = useState<RaisedAt>(() => new Map());
	const seq = useRef(0);
	const load = useCallback(() => {
		if (!enabled) return;
		const n = ++seq.current;
		void (async () => {
			try {
				const res = await fetch("/api/needs-you", { cache: "no-store" });
				if (!res.ok || n !== seq.current) return;
				const body = (await res.json()) as { items?: { wolf: string; threadId: string; raisedAt: string }[] };
				if (n !== seq.current || !Array.isArray(body.items)) return;
				const m = new Map<string, number>();
				for (const it of body.items) {
					const t = Date.parse(it.raisedAt);
					const k = `${it.wolf}\n${it.threadId}`;
					if (!Number.isNaN(t) && t < (m.get(k) ?? Infinity)) m.set(k, t);
				}
				setRaised(m);
			} catch {
				/* list order */
			}
		})();
	}, [enabled]);
	useEffect(() => load(), [load]);
	useOptionalServerEvent("needs-you-changed", load);
	return raised;
}

/** Another thread has a card waiting: count + that thread's color dot. One tap attaches the bar to the oldest waiting one (no toast, no auto-switch). */
function NeedsYouBadge({ waiting, all }: { waiting: (BarThread & { wolf: string })[]; all: BarThread[] }) {
	const api = useAttachedThread()!;
	const first = waiting[0]!;
	const color = useThreadColor({ id: first.id, ...(first.settings ? { settings: first.settings } : {}), ...(first.parentThreadId ? { parentThreadId: first.parentThreadId } : {}) }, all).hex;
	return (
		<button
			type="button"
			data-testid="chat-bar-needs-you"
			data-thread={first.id}
			title={`${waiting.length} waiting for you · oldest: ${first.title}`}
			aria-label={`${waiting.length} waiting for you. Attach the bar to ${first.title}`}
			onClick={() => api.attach({ wolf: first.wolf, threadId: first.id })}
			className="flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 font-ui text-[11px] text-amber-400 hover:bg-amber-500/25"
		>
			<span className="size-1.5 rounded-full" style={{ backgroundColor: color }} />
			{waiting.length}
		</button>
	);
}

/** The thread switcher: home + needs-you + recent feature threads, grouped by wolf. A dialog: focus moves in, arrows walk the entries, Esc / outside click close and return focus to the chip. */
export function Switcher({ groups, current, onClose }: { groups: SwitcherGroup[]; current: Pick<AttachedRef, "wolf" | "threadId">; onClose: () => void }) {
	const api = useAttachedThread();
	const ref = useRef<HTMLDivElement | null>(null);
	const items = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('[data-testid="switcher-entry"]') ?? []);
	useEffect(() => {
		const list = items();
		(list.find((b) => b.getAttribute("aria-current") === "true") ?? list[0] ?? ref.current)?.focus();
		const onDown = (e: MouseEvent) => {
			const t = e.target as Node | null;
			if (!t || ref.current?.contains(t)) return;
			if ((t as HTMLElement).closest?.('[data-testid="chat-bar-chip"]')) return; // the chip toggles it
			onClose();
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, []);
	const onKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			onClose();
			return;
		}
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
		e.preventDefault();
		const list = items();
		if (list.length === 0) return;
		const i = list.indexOf(document.activeElement as HTMLElement);
		list[(i + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]!.focus();
	};
	return (
		<div ref={ref} role="dialog" aria-label="Attach the bar to a thread" tabIndex={-1} onKeyDown={onKeyDown} data-testid="chat-bar-switcher" className="absolute bottom-full left-0 z-40 mb-2 max-h-80 w-72 overflow-y-auto rounded-xl border bg-popover p-1 shadow-lg outline-none">
			<p className="px-2 py-1 font-ui text-[10px] uppercase tracking-wide text-muted-foreground">Attach the bar to…</p>
			{groups.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">No threads yet.</p>}
			{groups.map((g) => (
				<div key={g.wolf} role="group" aria-label={g.wolf} data-testid="switcher-group" data-wolf={g.wolf}>
					<p className="px-2 pt-1.5 font-ui text-[10px] uppercase tracking-wide text-muted-foreground">{g.wolf}</p>
					{g.entries.map((e) => (
						<button
							key={e.threadId}
							type="button"
							data-testid="switcher-entry"
							data-thread={e.threadId}
							data-status={e.status}
							aria-current={e.wolf === current.wolf && e.threadId === current.threadId ? "true" : undefined}
							onClick={() => {
								api?.attach({ wolf: e.wolf, threadId: e.threadId, slug: e.slug });
								onClose();
							}}
							className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none", e.wolf === current.wolf && e.threadId === current.threadId && "bg-accent")}
						>
							<span className="min-w-0 flex-1 truncate">{e.title}</span>
							{e.status === "needs-you" && <span className="font-ui text-[10px] text-amber-400">needs you</span>}
							{e.status === "busy" && <span className="font-ui text-[10px] text-muted-foreground">working</span>}
						</button>
					))}
				</div>
			))}
		</div>
	);
}
