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
import { kbdEventForAction, type AttachedRef, type SwitcherGroup } from "@/src/core";

export { abortThread, onOwnThreadPage, submitToThread, whenBusyFor } from "@/components/chat-bar-io";

const BarComposer = dynamic(() => import("@/components/chat-bar-composer"), { ssr: false });

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
	}, [full, scrolls]);

	const closeSwitcher = useCallback(() => {
		setSwitcher(false);
		chipRef.current?.focus();
	}, []);

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
	const title = attachedThread ? (attachedThread.kind === "home" ? target.wolf : attachedThread.title) : target.slug;

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
			<div data-slot="chat-bar-card-surface" data-testid="chat-bar-card-surface" className="mb-2 empty:hidden" />
			<div className="relative rounded-2xl border bg-card shadow-lg" style={{ borderColor: color }}>
				<div className="flex items-center gap-1 px-1.5 pt-1">
					{chip}
					{working && <span data-testid="chat-bar-working" className="font-ui text-xs text-muted-foreground">working…</span>}
					{note && !working && <span data-testid="chat-bar-note" className="truncate font-ui text-xs text-muted-foreground">{note}</span>}
					<button type="button" aria-label="Minimize chat bar" data-testid="chat-bar-minimize" onClick={() => setMinimized(true)} className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-accent">
						<ChevronDownIcon className="size-4" />
					</button>
				</div>
				<BarComposer target={target} title={title} />
				{switcher && <Switcher groups={groups} current={target} onClose={closeSwitcher} />}
			</div>
		</div>
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
