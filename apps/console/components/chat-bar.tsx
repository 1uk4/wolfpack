"use client";

/**
 * THE FLOATING CHAT BAR: one pill, mounted once in the root layout, talking to the ONE thread the
 * AttachedThreadProvider holds, whatever page is open. It has NO stream and mounts no session model: it posts to the
 * thread's submit route (steering when a turn runs), aborts through the abort route, and shows "working…" from the
 * events channel (see attached-thread.tsx). Drafts share the thread page's key.
 *
 * On the attached thread's own page the bar is hidden (the page composer takes over; Cmd/Ctrl+J focuses it), EXCEPT while
 * dictating: then it shows there too, in full, REPLACING the page composer (ThreadChat unmounts its composer while the chat
 * owns the input). Stopping on that page docks it and the composer returns with the text; stopping anywhere else leaves it showing the words. Only the chip, the switcher and the shortcuts are eager; the input half (chat-bar-composer.tsx) loads on first expand.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import { usePathname, useRouter } from "next/navigation";
import { ChevronDownIcon, ChevronUpIcon, MessageSquareIcon, MicIcon, PictureInPicture2Icon } from "lucide-react";
import { cn } from "@/lib/utils";
import { BrailleSpinner } from "@/components/braille-spinner";
import { useAttachedThread } from "@/components/attached-thread";
import { FEATURE_GRADUATED } from "@/components/thread-closed";
import { abortThread as abortBarThread, onOwnThreadPage } from "@/components/chat-bar-io";
import { CompactMeter, finishDictation, publishBarDictation, useDictation, type Dictation } from "@/components/dictation";
import { appendToDraft, draftKey } from "@/lib/composer-draft";
import { useThreadColor } from "@/components/use-thread-color";
import { useBarCards, type BarCards } from "@/components/chat-bar-cards";
import type { Answering } from "@/components/ask-sheet";
import { replyLabel } from "@/components/ask-reply";
import { useOptionalServerEvent } from "@/components/server-events";
import { attachable, BAR_EXTRAS, kbdEventForAction, threadHref, type AttachedRef, type BarThread, type SwitcherGroup } from "@/src/core";

export { abortThread, onOwnThreadPage, submitToThread, whenBusyFor } from "@/components/chat-bar-io";

const loadComposer = () => import("@/components/chat-bar-composer");
const BarComposer = dynamic(loadComposer, { ssr: false });

/** The bar's stand-in for its composer once the attached thread has closed but a turn still runs: the same notice and Stop the thread page shows. The bar docks when the turn settles. */
function BarClosedNotice({ target, reason }: { target: AttachedRef; reason: string }) {
	return (
		<div data-testid="chat-bar-closed" className="px-3 py-2 text-sm">
			<div className="font-medium">{FEATURE_GRADUATED}</div>
			<div className="text-muted-foreground">{reason}</div>
			<button type="button" data-testid="chat-bar-closed-stop" onClick={() => void abortBarThread(target)} className="mt-2 rounded-md border px-3 py-1 text-sm">
				Stop the running turn
			</button>
		</div>
	);
}
/**
 * Finish the floating chat's own dictation run first (the words land in its draft), then run `then` (dock or navigate).
 * A page composer's run is not touched. A second call while one is pending is a no-op.
 */
let afterPending = false;
const afterBarDictation = (then?: () => void) => {
	if (afterPending) return;
	afterPending = true;
	void finishDictation("bar").then(() => then?.()).finally(() => void (afterPending = false));
};

const AskSheet = dynamic(() => import("@/components/ask-sheet").then((m) => m.AskSheet), { ssr: false });
const BarCardSurface = dynamic(() => import("@/components/bar-card-surface").then((m) => m.BarCardSurface), { ssr: false });

/** Pages that scroll: the open bar reserves room under their content. Full-height screens (graph, chat) are left alone. */
const SCROLLING = /^\/(kb|work|kb-activity|pipeline|settings|prompts)(\/|$)|^\/wolf\/[^/]+$/;

/** md+ (768px): the floating pill. Below it the bar is a full-width dock at the bottom (phone layout). */
const WIDE_QUERY = "(min-width: 768px)";
const canMatch = () => typeof window !== "undefined" && typeof window.matchMedia === "function";
function subscribeWide(cb: () => void): () => void {
	if (!canMatch()) return () => {};
	const mq = window.matchMedia(WIDE_QUERY);
	mq.addEventListener?.("change", cb);
	return () => mq.removeEventListener?.("change", cb);
}
/** Read synchronously (useSyncExternalStore), so a phone never paints the pill for a frame; the server snapshot is wide (desktop first). */
export function useWide(): boolean {
	return useSyncExternalStore(subscribeWide, () => (canMatch() ? window.matchMedia(WIDE_QUERY).matches : true), () => true);
}

/** A thread page has its own composer at the bottom, which the bar would cover, so the bar stays off those pages (phone dock and wide pill alike); the attached chat is a strip row there until it is opened. */
const THREAD_PAGE = /^\/wolf\/[^/]+\/thread(\/|$)|^\/chat\/new(\/|$)/;

/** Phone keyboard: how far the visual viewport's bottom sits above the layout viewport's bottom (iOS does not resize the layout, so a fixed dock would stay under the keyboard). 0 when the layout itself resizes (Android, interactive-widget=resizes-content). */
function useKeyboardInset(enabled: boolean): number {
	const [inset, setInset] = useState(0);
	useEffect(() => {
		const vv = window.visualViewport;
		if (!enabled || !vv) return setInset(0);
		const apply = () => setInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)));
		apply();
		vv.addEventListener("resize", apply);
		vv.addEventListener("scroll", apply);
		return () => {
			vv.removeEventListener("resize", apply);
			vv.removeEventListener("scroll", apply);
		};
	}, [enabled]);
	return inset;
}

export function ChatBar() {
	const api = useAttachedThread();
	const pathname = usePathname();
	const wide = useWide();
	const attached = api?.attached ?? null;
	const onOwn = onOwnThreadPage(pathname, attached);
	const [switcher, setSwitcher] = useState(false);
	const chipRef = useRef<HTMLButtonElement | null>(null);
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const minimized = api?.minimized ?? false;
	const phoneSheet = api?.phoneSheet ?? false;
	// A thread page's strip row can ask for the sheet (phoneSheet); otherwise the dock stays off there.
	// Wide: a requested bar that gets collapsed goes back to the row, not to a pill over the composer.
	const threadPage = !!pathname && THREAD_PAGE.test(pathname);
	const dockless = threadPage && (!phoneSheet || (wide && minimized));
	const scrolls = !!pathname && SCROLLING.test(pathname);

	// Shortcuts: the dispatcher hands over the KeyboardEvent; the browser's own key (Cmd+J = downloads) is swallowed only
	// when the bar (or, on its own thread's page, the page composer) actually answers.
	const live = useRef({ attached, onOwn, wide, minimized, setMinimized: api?.setMinimized, dock: api?.dock, dictating: false, threadPage, setPhoneSheet: api?.setPhoneSheet });

	// Dictation lives HERE, not in the composer: ChatBar stays mounted across page changes (and while the composer is
	// unmounted: minimized, or the phone on a thread page), so a run keeps listening while the owner browses. The
	// transcript goes to the composer when it is mounted, else straight into the thread's draft. Enabled only while a
	// thread is popped out; ⌘D routing is in dictation.tsx (shortcutHook).
	const composerAppend = useRef<((t: string) => void) | null>(null);
	const registerAppend = useCallback((fn: ((t: string) => void) | null) => void (composerAppend.current = fn), []);
	const dictation = useDictation({
		kind: "bar",
		enabled: !!attached,
		// The bar unmounting mid-run (the app shell going away) saves what was heard into the popped-out thread's draft.
		onOrphan: (t) => {
			const a = live.current.attached;
			if (a) appendToDraft(draftKey(a.wolf, a.threadId), t);
		},
		append: (t) => {
			if (composerAppend.current) return composerAppend.current(t);
			const a = live.current.attached;
			if (!a) return;
			appendToDraft(draftKey(a.wolf, a.threadId), t);
		},
	});

	// On its own thread's page the bar never shows, even while dictating: the page composer stays put and highlights
	// itself (thread-chat.tsx). Leaving the page mid-run makes `onOwn` false, and the bar appears with the run live.
	const dictating = dictation.active;
	const own = onOwn;
	live.current = { attached, onOwn, wide, minimized, setMinimized: api?.setMinimized, dock: api?.dock, dictating, threadPage, setPhoneSheet: api?.setPhoneSheet };
	const full = !!attached && !own && !dockless && (!wide || !minimized);
	const shown = !!attached && !own && !dockless;

	// Published so the popped-out thread's own page shows and drives the same run (use-thread-dictation.ts). Every field
	// the page reads is a dep (phase/active/error for the state, toggle/stop/finish/cancel for the actions, levelRef for
	// the meter); clearError only sets state, so a stale copy is as good as the current one.
	useEffect(() => {
		publishBarDictation(dictation, shown);
	}, [dictation.phase, dictation.error, dictation.active, dictation.levelRef, dictation.toggle, dictation.stop, dictation.finish, dictation.cancel, shown]);
	useEffect(() => () => publishBarDictation(null), []);

	// Landing on the popped-out thread's own page docks it (its page composer shows the draft), unless a run is live:
	// dictation keeps going and the bar stays. Only a navigation does this, so popping out on the page itself leaves it popped out.
	const setPhoneSheet = api?.setPhoneSheet;
	useEffect(() => setPhoneSheet?.(false), [pathname, setPhoneSheet]); // a requested sheet does not follow the owner to another page
	useEffect(() => {
		if (!attached) setPhoneSheet?.(false); // docked while the sheet was open: the flag must not outlive the bar
	}, [!!attached, setPhoneSheet]);
	useEffect(() => {
		if (wide && minimized) setPhoneSheet?.(false); // collapsed: the request is spent, the row is all that shows
	}, [wide, minimized, setPhoneSheet]);
	useEffect(() => {
		const l = live.current;
		if (api?.ready && onOwnThreadPage(pathname, l.attached) && !l.dictating) afterBarDictation(l.dock);
	}, [pathname, api?.ready]);

	// Stopping decides where the chat goes (mic, Cmd+D, Esc cancel, Enter-to-send all end the run the same way): stopped on
	// the thread's own page it docks back into the thread (the words are already in the thread's draft, which the page
	// composer shows); stopped anywhere else it stays, showing the words in its input. A failed start (error) leaves it be.
	// The target is the thread the run STARTED on, not whatever is attached at stop time: a handoff A→B (A finishes, B is
	// attached in the same batch) must not dock B because A's stop was seen with B attached.
	const wasDictating = useRef(false);
	const runThread = useRef<AttachedRef | null>(null);
	useEffect(() => {
		const was = wasDictating.current;
		wasDictating.current = dictating;
		if (!was && dictating) runThread.current = live.current.attached;
		if (was && !dictating) {
			const t = runThread.current;
			runThread.current = null;
			const a = live.current.attached;
			if (t && a && a.wolf === t.wolf && a.threadId === t.threadId && live.current.onOwn && !dictation.error) live.current.dock?.();
		}
	}, [dictating]);

	// Using another thread's composer docks the floating chat. Only a USER action counts: a pointerdown in a composer
	// outside the bar, or typing (keydown / beforeinput) into one. Focus alone never docks, so a page whose composer
	// autofocuses (a thread page, /chat/new) can be viewed without docking. Not the bar's own textarea, not a textarea
	// outside a composer, and not on the popped-out thread's own page (landing there already docked it). The bar composer
	// flushes its draft on unmount, so the text stays unsent in that thread's draft store.
	useEffect(() => {
		const other = (e: Event): boolean => {
			const t = e.target as HTMLElement | null;
			if (!t || !t.closest || t.closest('[data-testid="chat-bar"]')) return false;
			const box = t.closest('[data-testid="composer"]');
			return !!box && (t.tagName === "TEXTAREA" || e.type === "pointerdown");
		};
		const onUse = (e: Event) => {
			if (e.type === "keydown") {
				const k = e as KeyboardEvent;
				if (k.metaKey || k.ctrlKey || k.altKey || k.key === "Tab" || k.key === "Escape" || k.key === "Shift") return; // shortcuts and focus moves are not typing
			}
			const l = live.current;
			if (l.attached && !l.onOwn && other(e)) afterBarDictation(l.dock);
		};
		const evs = ["pointerdown", "keydown", "beforeinput"] as const;
		for (const n of evs) document.addEventListener(n, onUse, true);
		return () => {
			for (const n of evs) document.removeEventListener(n, onUse, true);
		};
	}, []);
	useEffect(() => {
		const focusInput = (n = 0) => {
			const el = document.querySelector('[data-testid="chat-bar"] textarea') as HTMLTextAreaElement | null;
			if (el) el.focus();
			else if (n < 30) requestAnimationFrame(() => focusInput(n + 1));
		};
		const onFocus = (e: Event) => {
			const kev = (e as CustomEvent<{ event?: KeyboardEvent }>).detail?.event;
			const l = live.current;
			// On its own page the page composer is always the input (dictating included).
			if (l.onOwn) {
				const page = document.querySelector('[data-testid="composer"] textarea') as HTMLTextAreaElement | null;
				if (!page) return;
				kev?.preventDefault();
				page.focus();
				return;
			}
			if (!l.attached || !l.wide) return;
			kev?.preventDefault();
			if (l.minimized) l.setMinimized?.(false);
			if (l.threadPage) l.setPhoneSheet?.(true); // another thread's page: Cmd+J opens the row's chat over it
			focusInput();
		};
		const onSwitcher = (e: Event) => {
			const kev = (e as CustomEvent<{ event?: KeyboardEvent }>).detail?.event;
			const l = live.current;
			if (!BAR_EXTRAS.switcher || !l.attached || !l.wide || l.onOwn) return;
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
	useLayoutEffect(() => {
		const root = document.documentElement;
		if (!full || (wide && !scrolls) || !wrapRef.current) {
			root.style.removeProperty("--chat-bar-reserve");
			return;
		}
		const el = wrapRef.current;
		// The dock sits flush at the bottom (no gap); the pill floats 12px up. The full-screen sheet covers the page, so its height is not reserved.
		const set = () => {
			if (el.dataset.state === "sheet") return;
			root.style.setProperty("--chat-bar-reserve", `${Math.ceil(el.getBoundingClientRect().height) + (wide ? 32 : 0)}px`);
		};
		set();
		const ro = new ResizeObserver(set);
		ro.observe(el);
		return () => {
			ro.disconnect();
			root.style.removeProperty("--chat-bar-reserve");
		};
	}, [full, scrolls, wide, attached?.wolf, attached?.threadId]);

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
	useEffect(() => {
		if (!shown) setSwitcher(false);
	}, [shown]);
	useEffect(() => {
		if (!attached) return;
		const idle = (window as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
		if (idle) idle(() => void loadComposer());
		else setTimeout(() => void loadComposer(), 200);
	}, [!!attached]);

	// Thread pages show the attached chat as a row in the subagent strip (attached-strip-row.tsx), never a pill.
	if (!api || !attached || own || dockless) return null;
	return <Bar key={`${attached.wolf}/${attached.threadId}`} phone={!wide} target={attached} wrapRef={wrapRef} chipRef={chipRef} switcher={switcher} setSwitcher={setSwitcher} closeSwitcher={closeSwitcher} dictation={dictation} registerAppend={registerAppend} />;
}

export function attachedThreadTitle(api: NonNullable<ReturnType<typeof useAttachedThread>>, a: AttachedRef): string {
	const t = api.attachedThread;
	return t ? (t.kind === "home" ? a.wolf : t.title) : a.slug;
}

/** A downward swipe of at least this many px on the sheet's handle closes it. */
const SWIPE_CLOSE_PX = 60;

function Bar({ target, phone, wrapRef, chipRef, switcher, setSwitcher, closeSwitcher, dictation, registerAppend }: {
	dictation: Dictation;
	registerAppend: (fn: ((t: string) => void) | null) => void;
	target: AttachedRef;
	phone: boolean;
	wrapRef: React.RefObject<HTMLDivElement | null>;
	chipRef: React.RefObject<HTMLButtonElement | null>;
	switcher: boolean;
	setSwitcher: (v: boolean | ((s: boolean) => boolean)) => void;
	closeSwitcher: () => void;
}) {
	const api = useAttachedThread()!;
	const { setMinimized, working, attachedThread, groups } = api;
	const minimized = api.minimized;
	const all = useMemo(() => Object.values(api.threads).flatMap((l) => l ?? []), [api.threads]);
	const wolfColor = api.wolves.find((w) => w.name === target.wolf)?.color;
	const color = useThreadColor({ id: target.threadId, ...(attachedThread?.kind ? { kind: attachedThread.kind } : {}), ...(attachedThread?.parentThreadId ? { parentThreadId: attachedThread.parentThreadId } : {}) }, all, wolfColor).hex;
	const router = useRouter();
	const rawCards = useBarCards(target, working, BAR_EXTRAS.cards || BAR_EXTRAS.peek || BAR_EXTRAS.ask);
	// A paged `ask` questionnaire has its own sheet (never the classic card path: the whole-card route refuses it). The other cards and the peek follow their extras.
	const askCard = BAR_EXTRAS.ask ? rawCards.pending.find((p) => p.card.paged === true) : undefined;
	const cards: BarCards = {
		...rawCards,
		pending: BAR_EXTRAS.cards ? rawCards.pending.filter((p) => !p.card.paged) : [],
		peek: BAR_EXTRAS.peek ? rawCards.peek : null,
		superseded: BAR_EXTRAS.cards ? rawCards.superseded : [],
		error: BAR_EXTRAS.cards ? rawCards.error : null,
	};
	const [answering, setAnswering] = useState<Answering | null>(null);
	const answeringNow = (() => {
		if (!answering || !askCard || askCard.callId !== answering.callId) return null;
		const i = askCard.card.fields.findIndex((f) => f.id === answering.qid);
		return i < 0 || !(askCard.card.steps?.[askCard.pageIndex ?? 0]?.fields ?? []).includes(answering.qid) ? null : replyLabel(askCard.card.fields[i]!);
	})();
	useEffect(() => {
		// The targeted question left the page (or the card is gone): the chip goes.
		if (answering && !answeringNow) setAnswering(null);
	}, [answering, answeringNow]);
	// While a question is answered in its sheet the bottom composer is hidden and the sheet fills the space it used.
	const composing = answering !== null && answeringNow !== null;
	const sheetCard = askCard ? (
		<div data-testid="ask-sheet-host" className={cn("flex min-h-0 flex-col", phone ? "flex-1" : composing ? "max-h-[85vh]" : "max-h-[70vh]")}>
			<AskSheet key={askCard.callId} target={target} pc={askCard} answering={answering} setAnswering={setAnswering} onSubmitted={(last) => (last ? rawCards.settle(askCard.callId) : rawCards.refetch())} onRefetch={rawCards.refetch} dictation={dictation} />
		</div>
	) : null;
	const raised = useRaisedAt(BAR_EXTRAS.badge && api.attached !== null);
	const waiting = useMemo(() => (BAR_EXTRAS.badge ? oldestFirst(waitingElsewhere(api.threads, target), raised) : []), [api.threads, target, raised]);
	const title = attachedThread ? (attachedThread.kind === "home" ? target.wolf : attachedThread.title) : target.slug;
	// Phone only: the dock expands into a full-screen sheet. The composer stays at the same spot in the tree, so the draft survives both ways.
	const [sheet, setSheet] = useState(api.phoneSheet);
	useEffect(() => {
		if (!sheet) api.setPhoneSheet(false);
	}, [sheet]);
	const inset = useKeyboardInset(phone);
	const swipeFrom = useRef<{ x: number; y: number } | null>(null);
	const opener = useRef<"strip" | "chevron">("chevron");
	const wasSheet = useRef(false);
	const openedForCard = useRef(false);
	const pendingCount = cards.pending.length + (askCard ? 1 : 0);
	useEffect(() => {
		// Answering the last card closes a sheet that was opened for it; a sheet opened to type stays.
		if (sheet && openedForCard.current && pendingCount === 0) {
			openedForCard.current = false;
			// Not while the owner is typing: a focused input or a draft in it keeps the sheet.
			const input = wrapRef.current?.querySelector("textarea");
			if (input && (document.activeElement === input || input.value.trim() !== "")) return;
			setSheet(false);
		}
	}, [sheet, pendingCount]);
	const openSheet = (forCard: boolean) => {
		openedForCard.current = forCard;
		opener.current = forCard ? "strip" : "chevron";
		setSheet(true);
	};
	// The sheet is a modal: focus goes in on open and back to what opened it on close; Esc closes it from anywhere; the page behind does not scroll.
	useEffect(() => {
		if (!sheet) {
			if (wasSheet.current) {
				wasSheet.current = false;
				const back = document.querySelector<HTMLElement>(`[data-testid="${opener.current === "strip" ? "bar-strip" : "bar-sheet-open"}"]`) ?? document.querySelector<HTMLElement>('[data-testid="bar-sheet-open"]');
				back?.focus();
			}
			return;
		}
		wasSheet.current = true;
		document.querySelector<HTMLElement>('[data-testid="bar-sheet-close"]')?.focus();
		const prevOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented) return;
			e.preventDefault();
			setSheet(false);
		};
		document.addEventListener("keydown", onKey);
		return () => {
			document.body.style.overflow = prevOverflow;
			document.removeEventListener("keydown", onKey);
		};
	}, [sheet]);
	const trapTab = (e: React.KeyboardEvent) => {
		if (!sheet || e.key !== "Tab") return;
		const box = wrapRef.current;
		if (!box) return;
		const items = Array.from(box.querySelectorAll<HTMLElement>('button:not([disabled]), textarea, input:not([type="hidden"]), a[href], [tabindex]:not([tabindex="-1"])')).filter((el) => !el.closest("[hidden]"));
		if (items.length === 0) return;
		const first = items[0]!;
		const last = items[items.length - 1]!;
		const at = document.activeElement;
		if (e.shiftKey && (at === first || !box.contains(at))) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && (at === last || !box.contains(at))) {
			e.preventDefault();
			first.focus();
		}
	};
	// The questionnaire sheet opens by itself on a phone when an ask arrives.
	const askId = askCard?.callId;
	useEffect(() => {
		if (askId && phone && !minimized) openSheet(true);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [askId, phone]);
	const hasSurface = (BAR_EXTRAS.cards || BAR_EXTRAS.peek) && (cards.pending.length > 0 || cards.superseded.length > 0 || !!cards.peek || !!cards.error);

	const badge = BAR_EXTRAS.badge && waiting.length > 0 ? <NeedsYouBadge waiting={waiting} all={all} /> : null;
	const chip = (
		<button
			ref={chipRef}
			type="button"
			data-testid="chat-bar-chip"
			aria-haspopup={BAR_EXTRAS.switcher ? "dialog" : undefined}
			aria-expanded={BAR_EXTRAS.switcher ? switcher : undefined}
			onClick={() => (minimized ? setMinimized(false) : BAR_EXTRAS.switcher ? setSwitcher((s) => !s) : afterBarDictation(() => router.push(threadHref(target.wolf, target.threadId))))}
			className={cn("flex items-center gap-1.5 rounded-full px-2.5 py-1 font-ui text-xs hover:bg-accent", phone ? "min-h-11 min-w-11 max-w-[60vw]" : "max-w-56")}
			title={`${target.wolf} · ${title}`}
		>
			<span data-testid="chat-bar-dot" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
			<span className="truncate">{title}</span>
			<span className="text-muted-foreground">{target.wolf}</span>
			{working && <BrailleSpinner />}
			{dictation.active && <MicIcon data-testid="chat-bar-listening" className="size-3 shrink-0 text-red-500" />}
		</button>
	);

	const dockBtn = (cls: string) => (
		<button type="button" aria-label="Dock chat" title="Dock: keeps your draft" data-testid="chat-bar-dock" onClick={() => afterBarDictation(api.dock)} className={cls}>
			<PictureInPicture2Icon className="size-4" />
		</button>
	);

	if (phone) {
		const bottomPad = inset > 0 ? 0 : "env(safe-area-inset-bottom)";
		const tap = "flex min-h-11 min-w-11 items-center justify-center rounded-full text-muted-foreground hover:bg-accent";
		const asSheet = sheet && !minimized;
		return (
			<>
			{asSheet && <button type="button" tabIndex={-1} aria-label="Close chat" data-testid="bar-sheet-backdrop" onClick={() => setSheet(false)} className="fixed inset-0 z-[69] bg-black/40" />}
			<div
				ref={wrapRef}
				data-testid="chat-bar"
				data-layout="dock"
				data-state={minimized ? "minimized" : sheet ? "sheet" : "open"}
				{...(sheet && !minimized ? { role: "dialog", "aria-modal": true, "aria-label": `Chat with ${title}` } : {})}
				className={cn("fixed inset-x-0 flex flex-col border-t bg-card shadow-lg", sheet ? cn("z-[70]", askCard ? "" : "rounded-t-2xl") : "z-30")}
				// A bottom sheet: sized to its content and capped at 70dvh (long content scrolls inside), anchored above the keyboard (bottom: inset), the page dimmed behind it.
				style={{ bottom: inset, paddingBottom: bottomPad, borderColor: color, ...(sheet ? (askCard ? { height: "100dvh", maxHeight: "100dvh" } : { maxHeight: "70dvh" }) : {}) }}
				onKeyDown={trapTab}
			>
				{sheet && !minimized && (
					<div
						data-testid="bar-sheet-handle"
						className="relative flex min-h-11 shrink-0 touch-none items-center justify-center"
						onTouchStart={(e) => {
							const t = e.touches[0];
							swipeFrom.current = t ? { x: t.clientX, y: t.clientY } : null;
						}}
						onTouchCancel={() => void (swipeFrom.current = null)}
						onTouchEnd={(e) => {
							const from = swipeFrom.current;
							swipeFrom.current = null;
							const t = e.changedTouches[0];
							if (!from || !t) return;
							const dy = t.clientY - from.y;
							if (dy >= SWIPE_CLOSE_PX && dy > Math.abs(t.clientX - from.x)) setSheet(false); // mostly-horizontal swipes are ignored
						}}
					>
						<span aria-hidden className="h-1 w-10 rounded-full bg-muted-foreground/40" />
						<button type="button" aria-label="Close full screen" data-testid="bar-sheet-close" onClick={() => setSheet(false)} className={cn(tap, "absolute right-1")}>
							<ChevronDownIcon className="size-5" />
						</button>
					</div>
				)}
				{sheet && !minimized && (
					<div data-slot="chat-bar-card-surface" data-testid="chat-bar-card-surface" className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
						{sheetCard}
						{hasSurface ? <BarCardSurface key={`${target.wolf}:${target.threadId}`} target={target} cards={cards} /> : sheetCard ? null : BAR_EXTRAS.cards || BAR_EXTRAS.peek ? <p className="px-2 py-3 font-ui text-sm text-muted-foreground">Nothing waiting. Write a message below.</p> : null}
					</div>
				)}
				{!sheet && !minimized && (hasSurface || askCard) && (
					<button
						type="button"
						data-testid="bar-strip"
						onClick={() => openSheet(pendingCount > 0)}
						className="flex min-h-11 w-full items-center justify-between gap-2 border-b px-3 text-left font-ui text-sm hover:bg-accent"
					>
						<span className="truncate">{pendingCount > 0 ? (pendingCount === 1 ? "1 card waiting" : `${pendingCount} cards waiting`) : cards.error ? "Could not send. Tap to see" : cards.superseded.length > 0 ? "Replied instead. Tap to see" : "New reply. Tap to read"}</span>
						<ChevronUpIcon className="size-4 shrink-0 text-muted-foreground" />
					</button>
				)}
				<div className="relative flex items-center gap-1 px-1.5">
					{chip}
					{badge}
					{working && !minimized && <span data-testid="chat-bar-working" className="font-ui text-xs text-muted-foreground">working…</span>}
					{minimized && <CompactMeter dictation={dictation} />}
					{minimized ? (
						<button type="button" aria-label="Expand chat bar" data-testid="chat-bar-expand" onClick={() => setMinimized(false)} className={cn(tap, "ml-auto")}>
							<MessageSquareIcon className="size-4" />
						</button>
					) : (
						<div className="ml-auto flex items-center">
							{!sheet && (
								<button type="button" aria-label="Open full screen" data-testid="bar-sheet-open" onClick={() => openSheet(false)} className={tap}>
									<ChevronUpIcon className="size-5" />
								</button>
							)}
							{dockBtn(tap)}
							<button type="button" aria-label="Minimize chat bar" data-testid="chat-bar-minimize" onClick={() => setMinimized(true)} className={tap}>
								<ChevronDownIcon className="size-4" />
							</button>
						</div>
					)}
				</div>
				{!minimized && (api.closedReason !== undefined ? <BarClosedNotice target={target} reason={api.closedReason} /> : composing ? null : <BarComposer target={target} title={title} cardOpen={pendingCount > 0} askOpen={!!askCard} onReplied={cards.replied} dictation={dictation} registerAppend={registerAppend} />)}
				{BAR_EXTRAS.switcher && switcher && <Switcher groups={groups} current={target} onClose={closeSwitcher} sheet />}
			</div>
			</>
		);
	}

	if (minimized) {
		return (
			<div data-testid="chat-bar" data-state="minimized" className="fixed bottom-3 left-1/2 z-30 -translate-x-1/2">
				<div className="relative rounded-full border bg-card shadow-md focus-within:ring-1 focus-within:ring-(color:--thread-accent)" style={{ borderColor: color }}>
					<div className="flex items-center">
						{chip}
						<CompactMeter dictation={dictation} />
						{badge}
						{dockBtn("rounded-full p-1 text-muted-foreground hover:bg-accent")}
						<button type="button" aria-label="Expand chat bar" data-testid="chat-bar-expand" onClick={() => setMinimized(false)} className="mr-1 rounded-full p-1 text-muted-foreground hover:bg-accent">
							<MessageSquareIcon className="size-3.5" />
						</button>
					</div>
					{BAR_EXTRAS.switcher && switcher && <Switcher groups={groups} current={target} onClose={closeSwitcher} />}
				</div>
			</div>
		);
	}

	return (
		<div ref={wrapRef} data-testid="chat-bar" data-state="open" className="fixed bottom-3 left-1/2 z-30 w-[min(42rem,calc(100vw-2rem))] -translate-x-1/2">
			{/* Card surface slot (PtJkpk6): the thread's pending question/brief cards and the last-reply peek mount here, above the input. */}
			<div data-slot="chat-bar-card-surface" data-testid="chat-bar-card-surface" className="mb-2 empty:hidden">
				{sheetCard}
				{hasSurface && <BarCardSurface key={`${target.wolf}:${target.threadId}`} target={target} cards={cards} />}
			</div>
			<div className="relative rounded-2xl border bg-card shadow-lg focus-within:ring-1 focus-within:ring-(color:--thread-accent)" style={{ borderColor: color }}>
				<div className="flex items-center gap-1 px-1.5 pt-1">
					{chip}
					{badge}
					{working && <span data-testid="chat-bar-working" className="font-ui text-xs text-muted-foreground">working…</span>}
					{dockBtn("ml-auto rounded-md p-1 text-muted-foreground hover:bg-accent")}
					<button type="button" aria-label="Minimize chat bar" data-testid="chat-bar-minimize" onClick={() => setMinimized(true)} className="rounded-md p-1 text-muted-foreground hover:bg-accent">
						<ChevronDownIcon className="size-4" />
					</button>
				</div>
				{api.closedReason !== undefined ? <BarClosedNotice target={target} reason={api.closedReason} /> : composing ? null : <BarComposer target={target} title={title} cardOpen={pendingCount > 0} askOpen={!!askCard} onReplied={cards.replied} dictation={dictation} registerAppend={registerAppend} />}
				{BAR_EXTRAS.switcher && switcher && <Switcher groups={groups} current={target} onClose={closeSwitcher} />}
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
	const color = useThreadColor({ id: first.id, ...(first.kind ? { kind: first.kind } : {}), ...(first.parentThreadId ? { parentThreadId: first.parentThreadId } : {}) }, all, api.wolves.find((w) => w.name === first.wolf)?.color).hex;
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
export function Switcher({ groups, current, onClose, sheet = false }: { groups: SwitcherGroup[]; current: Pick<AttachedRef, "wolf" | "threadId">; onClose: () => void; sheet?: boolean }) {
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
		<div ref={ref} role="dialog" aria-label="Attach the bar to a thread" tabIndex={-1} onKeyDown={onKeyDown} data-testid="chat-bar-switcher" data-layout={sheet ? "sheet" : "popover"} className={cn("z-50 overflow-y-auto bg-popover p-1 outline-none", sheet ? "fixed inset-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]" : "absolute bottom-full left-0 z-40 mb-2 max-h-80 w-72 rounded-xl border shadow-lg")}>
			<div className="flex items-center justify-between">
				<p className="px-2 py-1 font-ui text-[10px] uppercase tracking-wide text-muted-foreground">Attach the bar to…</p>
				{sheet && (
					<button type="button" aria-label="Close" data-testid="switcher-close" onClick={onClose} className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-muted-foreground hover:bg-accent">
						<ChevronDownIcon className="size-5" />
					</button>
				)}
			</div>
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
							className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent", sheet && "min-h-11", "focus-visible:bg-accent focus-visible:outline-none", e.wolf === current.wolf && e.threadId === current.threadId && "bg-accent")}
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
