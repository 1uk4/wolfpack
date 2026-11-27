"use client";

/**
 * THE FLOATING CHAT BAR: one pill, mounted once in the root layout, talking to the ONE thread the
 * AttachedThreadProvider holds, whatever page is open. It has NO stream and mounts no session model: it posts to the
 * thread's submit route (steering when a turn runs), aborts through the abort route, and shows "working…" from the
 * events channel (see attached-thread.tsx). Drafts share the thread page's key.
 *
 * Docking is automatic (there is no pop-out/dock button). On the attached thread's own page the bar renders nothing: the page
 * composer IS the chat (Cmd/Ctrl+J focuses it), except in viz mode where the bar shows there and replaces it. On any OTHER thread
 * page the bar floats over it with a "Swap to <thread>" pill; the page's composer steps aside (thread-chat.tsx pads its strips by
 * --chat-bar-over), so there is only ever one composer, and the pill attaches that page's thread, which docks into it.
 * Only the chip, the switcher and the shortcuts are eager; the input half (chat-bar-composer.tsx) loads on first expand.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useDockSlot } from "@/components/chat-bar/dock-slot";
import { getPageNoteAppend } from "@/components/composer/page-note-append";
import dynamic from "next/dynamic";
import { usePathname, useRouter } from "next/navigation";
import { ArrowLeftRightIcon, EyeIcon, MessageCircleQuestionIcon, ChevronDownIcon, ChevronUpIcon, MessageSquareIcon, MicIcon } from "lucide-react";
import { Hint } from "@/components/ui/hint";
import { useSubagentChildren } from "@/components/thread/use-subagent-children";
import { cn } from "@/lib/utils";
import { BrailleSpinner } from "@/components/shell/braille-spinner";
import { useAttachedThread } from "@/components/chat-bar/attached-thread";
import { FEATURE_GRADUATED } from "@/components/thread/thread-closed";
import { abortThread as abortBarThread, onOwnThreadPage, swapTarget } from "@/components/chat-bar/chat-bar-io";
import { CompactMeter, finishDictation, publishBarDictation, useDictation, type Dictation } from "@/components/composer/dictation";
import { appendToDraft, draftKey } from "@/lib/composer-draft";
import { setVizMode, useVizActive } from "@/components/viewer/viz-mode";
import { useFrameBadges } from "@/components/viewer/frame-store";
import { FrameBadges } from "@/components/viewer/frame-badges";
import { BarIcon } from "@/components/chat-bar/bar-icon";
import { BarSettings } from "@/components/chat-bar/bar-settings";
import { useKeyboardInset } from "@/components/chat-bar/use-keyboard-inset";
import { useBarHiddenReasons } from "@/components/chat-bar/bar-visibility";
import { BarOverflow } from "@/components/chat-bar/bar-overflow";
import { useColumnRect } from "@/components/chat-bar/column-store";
import { useThreadColor } from "@/components/thread/use-thread-color";
import { useBarCards, type BarCards } from "@/components/chat-bar/chat-bar-cards";
import type { Answering } from "@/components/ask/ask-sheet";
import { askQueue, useAskQueue, useAskSession, type NoteState } from "@/components/ask/ask-session";
import { replyLabel } from "@/components/ask/ask-reply";
import { useOptionalServerEvent } from "@/components/shell/server-events";
import { attachable, barGeometry, barHiddenFor, pickHomeThread, inFrozenOrder, switcherOrder, hasPagePendingAsk, subscribePagePending, BAR_EXTRAS, kbdEventForAction, resolveThreadId, threadHref, type AttachedRef, type BarThread, type SwitcherGroup } from "@/src/core";

export { abortThread, onOwnThreadPage, submitToThread, whenBusyFor } from "@/components/chat-bar/chat-bar-io";

const loadComposer = () => import("@/components/chat-bar/chat-bar-composer");
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

const AskSheet = dynamic(() => import("@/components/ask/ask-sheet").then((m) => m.AskSheet), { ssr: false });
const BarCardSurface = dynamic(() => import("@/components/chat-bar/bar-card-surface").then((m) => m.BarCardSurface), { ssr: false });

/** Full-height screens (the graph canvas, the new-chat page, a thread page) run under the bar; every other page scrolls, so the open bar reserves room under its content. */
const FULL_HEIGHT = /^\/(graph|chat)(\/|$)|^\/wolf\/[^/]+\/thread(\/|$)/;

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

export function ChatBar() {
	const api = useAttachedThread();
	const pathname = usePathname();
	const wide = useWide();
	const attached = api?.attached ?? null;
	const onOwnPage = onOwnThreadPage(pathname, attached);
	// Visualization mode on the attached thread's own page: the page composer is hidden, so the bar shows there (chat and questionnaires only).
	const viz = useVizActive();
	const vizHere = onOwnPage && !!viz && !!attached && viz.wolf === attached.wolf && viz.threadId === attached.threadId;
	const onOwn = onOwnPage && !vizHere;
	const [switcher, setSwitcher] = useState(false);
	const chipRef = useRef<HTMLButtonElement | null>(null);
	const wrapRef = useRef<HTMLDivElement | null>(null);
	// Another thread's page: the bar floats over it with a "Swap to <thread>" pill (the page's own composer steps aside).
	// On the attached thread's own page the page composer is the docked chat and this bar renders nothing (except in viz mode).
	// swapTarget is the one predicate thread-chat.tsx also reads to step its composer aside, so a hidden composer always has its pill.
	const page = swapTarget(pathname, attached);
	const pageThreadId = page ? (resolveThreadId(page.wolf, page.slug, api?.threads[page.wolf] ?? []) ?? `${page.wolf}/${page.slug}`) : null;
	const swap = page && pageThreadId ? { wolf: page.wolf, slug: page.slug, threadId: pageThreadId } : null;
	// The pill is the way to type to that page's thread, so a minimized bar still opens over a thread page.
	const minimized = (api?.minimized ?? false) && !swap;
	const hiddenReasons = useBarHiddenReasons();
	const hidden = barHiddenFor(pathname, { reasons: hiddenReasons });
	const scrolls = !!pathname && !FULL_HEIGHT.test(pathname);

	// Shortcuts: the dispatcher hands over the KeyboardEvent; the browser's own key (Cmd+J = downloads) is swallowed only
	// when the bar (or, on its own thread's page, the page composer) actually answers.
	// Visualization mode on the attached thread (anywhere): the bar has no switcher then, so its shortcut does nothing either.
	const vizAttached = !!viz && !!attached && viz.wolf === attached.wolf && viz.threadId === attached.threadId;
	const live = useRef({ attached, onOwn, wide, minimized, setMinimized: api?.setMinimized, dictating: false, vizAttached });

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
			const note = getPageNoteAppend(); // the thread page's own open questionnaire note (the bar has no composer there)
			if (note && live.current.onOwn) return note(t);
			const a = live.current.attached;
			if (!a) return;
			appendToDraft(draftKey(a.wolf, a.threadId), t);
		},
	});

	// On its own thread's page the bar never shows, even while dictating: the page composer stays put and highlights
	// itself (thread-chat.tsx). Leaving the page mid-run makes `onOwn` false, and the bar appears with the run live.
	const dictating = dictation.active;
	const own = onOwn;
	const dockSlot = useDockSlot();
	live.current = { attached, onOwn, wide, minimized, setMinimized: api?.setMinimized, dictating, vizAttached };
	const full = !!attached && !own && !hidden && !minimized;
	const shown = !!attached && !own && !hidden;
	const docked = own && !!dockSlot && !hidden;

	// Published so the popped-out thread's own page shows and drives the same run (use-thread-dictation.ts). Every field
	// the page reads is a dep (phase/active/error for the state, toggle/stop/finish/cancel for the actions, levelRef for
	// the meter); clearError only sets state, so a stale copy is as good as the current one.
	useEffect(() => {
		publishBarDictation(dictation, shown || docked);
	// eslint-disable-next-line react-hooks/exhaustive-deps -- the listed dictation fields are the ones the page reads; the dictation object itself is new every render
	}, [dictation.phase, dictation.error, dictation.active, dictation.levelRef, dictation.toggle, dictation.stop, dictation.finish, dictation.cancel, shown, docked]);
	useEffect(() => () => publishBarDictation(null), []);

	// Docking is automatic and never clears the attachment: on the attached thread's own page the page composer IS the chat
	// (this bar renders nothing there), on any other thread page the bar floats with a swap pill, elsewhere it floats as is.

	useEffect(() => {
		const focusInput = (n = 0) => {
			const el = document.querySelector('[data-testid="chat-bar"] textarea') as HTMLTextAreaElement | null;
			if (el) el.focus();
			else if (n < 30) requestAnimationFrame(() => focusInput(n + 1));
		};
		const onFocus = (e: Event) => {
			const kev = (e as CustomEvent<{ event?: KeyboardEvent }>).detail?.event;
			const l = live.current;
			// Nothing attached: the icon is the chat; focus it (Enter opens it).
			if (!l.attached) {
				const icon = document.querySelector('[data-testid="chat-bar-expand"]') as HTMLElement | null;
				if (!icon) return;
				kev?.preventDefault();
				icon.focus();
				return;
			}
			// On its own page the docked bar is the input; the page's own composer only when the bar is not docked there (no slot).
			if (l.onOwn) {
				const page = (document.querySelector('[data-testid="chat-bar"] textarea') ?? document.querySelector('[data-testid="composer"] textarea')) as HTMLTextAreaElement | null;
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
			if (!BAR_EXTRAS.switcher || !l.attached || !l.wide || l.onOwn || l.vizAttached) return;
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

	// --chat-bar-top: how far the top of the bar (swap pill included, plus the bar's own bottom offset) sits above the viewport bottom,
	// so other pages (the graph controls) can sit above it. 0px with no bar; written once per frame; removed on cleanup.
	useLayoutEffect(() => {
		const root = document.documentElement;
		if (!shown || !wrapRef.current) {
			root.style.removeProperty("--chat-bar-top");
			return;
		}
		const el = wrapRef.current;
		const set = () => {
			if (el.dataset.state === "sheet") return void root.style.removeProperty("--chat-bar-top");
			const pill = el.querySelector<HTMLElement>('[data-testid="chat-bar-swap-wrap"]');
			const top = Math.min(el.getBoundingClientRect().top, pill ? pill.getBoundingClientRect().top : Infinity);
			root.style.setProperty("--chat-bar-top", `${Math.max(0, Math.ceil(window.innerHeight - top))}px`);
		};
		set();
		let frame = 0;
		const schedule = () => {
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				set();
			});
		};
		const ro = new ResizeObserver(schedule);
		ro.observe(el);
		const vv = window.visualViewport;
		vv?.addEventListener("resize", schedule);
		vv?.addEventListener("scroll", schedule);
		window.addEventListener("resize", schedule);
		return () => {
			if (frame) cancelAnimationFrame(frame);
			ro.disconnect();
			vv?.removeEventListener("resize", schedule);
			vv?.removeEventListener("scroll", schedule);
			window.removeEventListener("resize", schedule);
			root.style.removeProperty("--chat-bar-top");
		};
	}, [shown, minimized, wide, !!swap, attached?.wolf, attached?.threadId]);

	// Over another thread's page: that page's dock (sub-agent strip, pinned strip) pads its bottom by the bar's real height
	// (--chat-bar-over, read in thread-chat.tsx) so nothing of it peeks out under or behind the bar.
	const overPage = !!swap && shown;
	useLayoutEffect(() => {
		const root = document.documentElement;
		if (!overPage || !wrapRef.current) {
			root.style.removeProperty("--chat-bar-over");
			return;
		}
		const el = wrapRef.current;
		// How far the bar (and the swap pill above it) reaches up from the bottom edge: measured, not guessed, so the pad is right for the
		// floating pill (12px gap), the phone dock (flush, lifted by the keyboard inset) and a pill that wraps. The full-screen sheet covers the page: no pad.
		const set = () => {
			if (el.dataset.state === "sheet") return void root.style.removeProperty("--chat-bar-over");
			const pill = el.querySelector<HTMLElement>('[data-testid="chat-bar-swap-wrap"]');
			const top = Math.min(el.getBoundingClientRect().top, pill ? pill.getBoundingClientRect().top : Infinity);
			// Clamped: with the iOS keyboard up the dock rides high, and the page's strips must not be squeezed to nothing.
			const pad = Math.min(Math.max(0, Math.ceil(window.innerHeight - top)), Math.floor(0.6 * window.innerHeight));
			root.style.setProperty("--chat-bar-over", `${pad}px`);
		};
		set();
		// visualViewport fires resize/scroll in bursts while the keyboard animates: one measure per frame.
		let frame = 0;
		const schedule = () => {
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				set();
			});
		};
		const ro = new ResizeObserver(schedule);
		ro.observe(el);
		// The phone keyboard lifts the dock (bottom: inset) without resizing it: re-measure when the visual viewport moves.
		const vv = window.visualViewport;
		vv?.addEventListener("resize", schedule);
		vv?.addEventListener("scroll", schedule);
		window.addEventListener("resize", schedule);
		return () => {
			if (frame) cancelAnimationFrame(frame);
			ro.disconnect();
			vv?.removeEventListener("resize", schedule);
			vv?.removeEventListener("scroll", schedule);
			window.removeEventListener("resize", schedule);
			root.style.removeProperty("--chat-bar-over");
		};
	}, [overPage, minimized, wide, attached?.wolf, attached?.threadId]);

	// Viz mode: the viewer's scroller pads its bottom by the bar's real height (--chat-bar-h) so the last lines clear the floating bar.
	useLayoutEffect(() => {
		const root = document.documentElement;
		if (!vizHere || !wrapRef.current) {
			root.style.removeProperty("--chat-bar-h");
			return;
		}
		const el = wrapRef.current;
		const set = () => {
			if (el.dataset.state === "sheet") return;
			root.style.setProperty("--chat-bar-h", `${Math.ceil(el.getBoundingClientRect().height)}px`);
		};
		set();
		const ro = new ResizeObserver(set);
		ro.observe(el);
		return () => {
			ro.disconnect();
			root.style.removeProperty("--chat-bar-h");
		};
	}, [vizHere, minimized, wide, attached?.wolf, attached?.threadId]);

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
	// eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on whether a thread is attached, not on the attached object identity
	}, [!!attached]);

	if (!api || hidden) return null;
	// Nothing attached (a fresh browser, the hub down): the icon is still on every page; a press attaches the owner's home thread.
	if (!attached) return <DetachedIcon phone={!wide} dictation={dictation} />;
	// The attached thread's own page: the page composer is the chat there.
	if (own && !dockSlot) return null;
	const bar = <Bar key={`${attached.wolf}/${attached.threadId}`} docked={own} swap={swap} phone={!wide} target={attached} wrapRef={wrapRef} chipRef={chipRef} switcher={switcher} setSwitcher={setSwitcher} closeSwitcher={closeSwitcher} dictation={dictation} registerAppend={registerAppend} />;
	// Docked: the same Bar is portalled into the thread page's slot (the page's composer position), so one component serves both places.
	return own && dockSlot ? createPortal(bar, dockSlot) : bar;
}

/** The icon with nothing attached: it opens the owner's home thread (the bar attaches it) when there is one. */
function DetachedIcon({ phone, dictation }: { phone: boolean; dictation: Dictation }) {
	const api = useAttachedThread()!;
	const needsYou = api.groups.reduce((n, g) => n + g.needsYou, 0);
	return (
		<BarIcon
			phone={phone}
			label={needsYou > 0 ? `Open chat (${needsYou} waiting for you)` : "Open chat"}
			color="var(--border)"
			wolfStatus="online"
			needsYou={needsYou}
			working={false}
			dictation={dictation}
			onExpand={() => {
				const home = pickHomeThread(api.wolves, api.threads);
				if (home) api.attach(home);
				api.setMinimized(false);
			}}
		/>
	);
}

export function attachedThreadTitle(api: NonNullable<ReturnType<typeof useAttachedThread>>, a: AttachedRef): string {
	const t = api.attachedThread;
	return t ? (t.kind === "home" ? a.wolf : t.title) : a.slug;
}

/** A downward swipe of at least this many px on the sheet's handle closes it. */
const SWIPE_CLOSE_PX = 60;

/** FLIP: a bar that moves between the page's dock slot and floating remounts (a portal change), so the last rect is handed over here and the new mount slides from it (~200ms, never under reduced motion). */
let lastBarRect: { rect: DOMRect; at: number } | null = null;

function Bar({ docked = false, target, swap, phone, wrapRef, chipRef, switcher, setSwitcher, closeSwitcher, dictation, registerAppend }: {
	/** In the thread page's dock slot: static, full width of the slot, not floating. */
	docked?: boolean;
	dictation: Dictation;
	registerAppend: (fn: ((t: string) => void) | null) => void;
	target: AttachedRef;
	/** The thread page the bar floats over, when it is not the attached thread: the bar offers a swap to it. */
	swap: { wolf: string; slug: string; threadId: string } | null;
	phone: boolean;
	wrapRef: React.RefObject<HTMLDivElement | null>;
	chipRef: React.RefObject<HTMLButtonElement | null>;
	switcher: boolean;
	setSwitcher: (v: boolean | ((s: boolean) => boolean)) => void;
	closeSwitcher: () => void;
}) {
	const api = useAttachedThread()!;
	const { setMinimized, working, attachedThread, groups } = api;
	useLayoutEffect(() => {
		const el = wrapRef.current;
		const prev = lastBarRect;
		lastBarRect = null;
		if (el && prev && Date.now() - prev.at < 400 && typeof el.animate === "function" && !(typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches)) {
			const to = el.getBoundingClientRect();
			const dx = prev.rect.left - to.left;
			const dy = prev.rect.top - to.top;
			if (Math.abs(dx) > 1 || Math.abs(dy) > 1) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], { duration: 200, easing: "ease-out" });
		}
		return () => {
			if (el) lastBarRect = { rect: el.getBoundingClientRect(), at: Date.now() };
		};
	// eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount: the portal change remounts the Bar
	}, [docked]);
	const minimized = api.minimized && !swap;
	const needsYouTotal = groups.reduce((n, g) => n + g.needsYou, 0);
	const all = useMemo(() => Object.values(api.threads).flatMap((l) => l ?? []), [api.threads]);
	const wolfColor = api.wolves.find((w) => w.name === target.wolf)?.color;
	const color = useThreadColor({ id: target.threadId, ...(attachedThread?.kind ? { kind: attachedThread.kind } : {}), ...(attachedThread?.parentThreadId ? { parentThreadId: attachedThread.parentThreadId } : {}) }, all, wolfColor).hex;
	const router = useRouter();
	const onThreadPage = onOwnThreadPage(usePathname(), target);
	const rawCards = useBarCards(target, working, BAR_EXTRAS.cards || BAR_EXTRAS.peek || BAR_EXTRAS.ask);
	// A paged `ask` questionnaire has its own sheet (never the classic card path: the whole-card route refuses it). The other cards and the peek follow their extras.
	const queue = useAskQueue(BAR_EXTRAS.ask ? askQueue(rawCards.pending) : []);
	const askCard = queue.current;
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
	// One questionnaire session for the bar: the answers, the page cursor and the note (the bar composer is the note's while the sheet is expanded).
	// Collapsing moves the note into the bar's normal draft: the text through the draft store, the images through the composer's sink.
	const noteSink = useRef<((n: NoteState) => void) | null>(null);
	const registerNoteSink = useCallback((fn: ((n: NoteState) => void) | null) => void (noteSink.current = fn), []);
	const session = useAskSession(target, askCard, {
		onSubmitted: (id) => rawCards.settle(id),
		queued: queue.ids,
		onRefetch: rawCards.refetch,
		onCollapse: (n) => {
			if (n.text.trim() !== "") appendToDraft(draftKey(target.wolf, target.threadId), n.text);
			noteSink.current?.(n);
		},
	});
	// Phone only: the dock can expand into a full-screen sheet (chevron). A pending questionnaire does NOT open it: it renders inline in the dock, above the composer, as in the thread.
	const [sheet, setSheet] = useState(false);
	const inset = useKeyboardInset(phone);
	// Inline, the ask scrolls inside the visible area: 55% of the viewport, less the iOS keyboard (the dock sits above it, `inset` is its height).
	const inlineCap = `min(55dvh, 55vh, calc((100dvh - ${inset}px) * 0.55))`;
	const sheetCard = askCard ? (
		session.expanded ? (
			<div data-testid="ask-sheet-host" data-composing={composing ? "true" : undefined} style={phone ? (sheet ? undefined : { maxHeight: inlineCap }) : composing ? undefined : { borderColor: color }} className={cn("flex min-h-0 flex-col overflow-hidden bg-card", phone ? (sheet ? "flex-1" : "shrink-0") : cn("rounded-t-2xl border border-b-0 shadow-lg", composing ? "max-h-[85vh]" : "max-h-[70vh]"))}>
				<AskSheet key={askCard.callId} target={target} session={session} queue={queue} answering={answering} setAnswering={setAnswering} dictation={dictation} />
			</div>
		) : (
			<button type="button" data-testid="ask-sheet-reopen" onClick={() => session.setExpanded(true)} className="flex min-h-11 w-full items-center justify-between gap-2 rounded-xl border border-l-2 border-l-(color:--thread-accent) bg-card px-3 text-left font-ui text-xs shadow-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
				<span className="font-medium text-foreground">{queue.count >= 2 ? `Questions waiting (${queue.count})` : "Questions waiting"}</span>
				<ChevronUpIcon aria-hidden className="size-4 text-muted-foreground" />
			</button>
		)
	) : null;
	const raised = useRaisedAt(BAR_EXTRAS.badge && api.attached !== null);
	const approvals = useApprovalEntries(BAR_EXTRAS.badge && api.attached !== null);
	const waiting = useMemo(() => (BAR_EXTRAS.badge ? oldestFirst(waitingElsewhere(api.threads, target), raised) : []), [api.threads, target, raised]);
	const title = attachedThread ? (attachedThread.kind === "home" ? target.wolf : attachedThread.title) : target.slug;
	// The composer stays at the same spot in the tree, so the draft survives both ways.
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
	// eslint-disable-next-line react-hooks/exhaustive-deps -- wrapRef is a stable ref object
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
	const hasSurface = (BAR_EXTRAS.cards || BAR_EXTRAS.peek) && (cards.pending.length > 0 || cards.superseded.length > 0 || !!cards.peek || !!cards.error);

	// Visualization mode: chat and questionnaires only (no needs-you badge, no thread switcher), and on the phone the dock sits over the viewer's full-screen sheet (z-40).
	const vizActive = useVizActive();
	const vizOn = !!vizActive && vizActive.wolf === target.wolf && vizActive.threadId === target.threadId;
	const badge = BAR_EXTRAS.badge && !vizOn && (waiting.length > 0 || approvals.length > 0) ? <NeedsYouBadge waiting={waiting} all={all} approvals={approvals} /> : null;
	// Same source as the thread page's strip, so the two always agree on what is running.
	const running = useSubagentChildren(target.wolf, target.slug, target.threadId).filter((c) => c.state === "running");
	const subagentChip = running.length > 0 && !vizOn ? (
		<Hint label={`Running: ${running.map((c) => c.agent ?? "agent").join(", ")}`}>
			<button type="button" data-testid="chat-bar-subagents" aria-label={`${running.length} sub-agent${running.length === 1 ? "" : "s"} running`} onClick={() => router.push(threadHref(target.wolf, target.threadId))} className="flex shrink-0 items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 font-ui text-xs text-muted-foreground hover:bg-accent max-md:min-h-11">
				<BrailleSpinner />
				{running.length}
			</button>
		</Hint>
	) : null;
	const lead = badge || subagentChip ? <>{badge}{subagentChip}</> : null;
	// Every badge of the bar (frame chips, needs-you, approvals, running sub-agents) rides one scrolling row inside the bar's surface, between the card slot and the header.
	const chipRow = (
		<FrameBadges bar wolf={target.wolf} threadId={target.threadId} vizOn={vizOn} lead={lead} onNavigate={onThreadPage ? undefined : (view) => router.push(`${threadHref(target.wolf, target.threadId)}?view=${encodeURIComponent(view)}`)} />
	);
	const chip = (
		<button
			ref={chipRef}
			type="button"
			data-testid="chat-bar-chip"
			aria-haspopup={BAR_EXTRAS.switcher ? "dialog" : undefined}
			aria-expanded={BAR_EXTRAS.switcher ? switcher : undefined}
			onClick={() => (BAR_EXTRAS.switcher ? (vizOn ? undefined : setSwitcher((s) => !s)) : afterBarDictation(() => router.push(threadHref(target.wolf, target.threadId))))}
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

	const swapThread = swap ? api.threads[swap.wolf]?.find((t) => t.id === swap.threadId) : undefined;
	const swapTitle = swap ? (swapThread ? (swapThread.kind === "home" ? swap.wolf : swapThread.title) : swap.slug) : "";
	// The page's thread is waiting on the owner: the thread list says needs-you, OR the page itself reports a pending paged ask (page-pending.ts; the list can lag
	// after a reconnect). Its ask sheet is hidden under the bar (thread-chat.tsx), so the pill turns amber and says Answer; choosing it docks into the page.
	// Covers asks only: approvals are work-request scoped (/api/needs-you has no thread), so they cannot be tied to this thread and show in the badge row instead.
	const pageAsk = useSyncExternalStore(subscribePagePending, () => (swap ? hasPagePendingAsk(swap.wolf, swap.threadId) : false), () => false);
	const swapNeedsYou = swapThread?.status === "needs-you" || pageAsk;
	const swapLabel = swapNeedsYou ? `Answer ${swapTitle}` : `Swap to ${swapTitle}`;
	// Desktop: centred on the page column (the thread chat column, else main). A narrow column is compact: the secondary controls move into a ... menu.
	const col = useColumnRect();
	const geo = barGeometry({ colLeft: col.left, colWidth: col.width, viewportWidth: (typeof window === "undefined" ? 0 : window.innerWidth) || 1280 });
	const compact = !phone && geo.compact;
	// Not while a send's POST is in flight: a failed send puts the text back into this bar's composer, which a swap would have unmounted.
	// Narrow gap left: if the attachment changes elsewhere (another tab/wolf) mid-send, the keyed Bar remounts and `sending` resets.
	const [sending, setSending] = useState(false);
	// A pill above the send button, on the right: one tap attaches to the thread whose page is open, and the bar steps aside for that page's own composer.
	const swapPill = swap && !minimized && !compact ? (
		<div data-testid="chat-bar-swap-wrap" className={cn("pointer-events-none absolute bottom-full z-10 mb-2 flex justify-end", phone ? "right-3" : "right-2")}>
			<Hint label={swapLabel}>
				<button
					type="button"
					data-testid="chat-bar-swap"
					data-needs-you={swapNeedsYou ? "true" : undefined}
					aria-label={swapLabel}
					disabled={sending}
					aria-busy={sending || undefined}
					onClick={() => void (!sending && afterBarDictation(() => api.attach({ wolf: swap.wolf, threadId: swap.threadId, slug: swap.slug })))}
					className={cn("pointer-events-auto flex max-w-[16rem] items-center gap-1.5 rounded-full border bg-card px-3 py-1.5 font-ui text-xs shadow-md transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60 motion-reduce:transition-none motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-200", swapNeedsYou && "border-amber-500/40 text-amber-600 dark:text-amber-400", phone && "min-h-11")}
				>
					{swapNeedsYou ? <MessageCircleQuestionIcon aria-hidden className="size-3.5 shrink-0" /> : <ArrowLeftRightIcon aria-hidden className="size-3.5 shrink-0" />}
					<span className="truncate">{swapLabel}</span>
				</button>
			</Hint>
		</div>
	) : null;

	// Collapsed: a small draggable icon on every screen size. It keeps the bar's `chat-bar` test id and "minimized" state; over another thread's page the bar never collapses (`minimized` is false then), because the swap pill is the way to type there.
	if (minimized) {
		return (
			<BarIcon
				phone={phone}
				label={needsYouTotal > 0 ? `Expand chat bar (${needsYouTotal} waiting for you)` : "Expand chat bar"}
				color={color}
				wolfStatus={api.wolves.find((w) => w.name === target.wolf)?.status ?? "online"}
				needsYou={needsYouTotal}
				working={working}
				dictation={dictation}
				onExpand={() => setMinimized(false)}
			/>
		);
	}

	if (phone) {
		const bottomPad = inset > 0 ? 0 : "env(safe-area-inset-bottom)";
		const tap = "flex min-h-11 min-w-11 items-center justify-center rounded-full text-muted-foreground hover:bg-accent";
		const asSheet = sheet && !minimized;
		return (
			<>
			{asSheet && <button type="button" tabIndex={-1} aria-label="Close chat" data-testid="bar-sheet-backdrop" onClick={() => setSheet(false)} className="fixed inset-0 z-[46] bg-black/40" />}
			<div
				ref={wrapRef}
				data-testid="chat-bar"
				data-layout="dock"
				data-state={minimized ? "minimized" : sheet ? "sheet" : "open"}
				{...(sheet && !minimized ? { role: "dialog", "aria-modal": true, "aria-label": `Chat with ${title}` } : {})}
				className={cn("fixed inset-x-0 flex flex-col border-t bg-card shadow-lg", sheet ? cn("z-[47]", askCard ? "" : "rounded-t-2xl") : vizOn ? "z-[45]" : "z-30")}
				// A bottom sheet: sized to its content and capped at 70dvh (long content scrolls inside), anchored above the keyboard (bottom: inset), the page dimmed behind it.
				style={{ bottom: inset, paddingBottom: bottomPad, ...(composing ? {} : { borderColor: color }), ...(sheet ? (askCard ? { height: "100dvh", maxHeight: "100dvh" } : { maxHeight: "70dvh" }) : {}) }}
				onKeyDown={trapTab}
			>
				{!sheet && swapPill}
				{!sheet && !minimized && sheetCard && <div data-testid="bar-ask-inline" className="flex min-h-0 shrink-0 flex-col px-2 pb-1 pt-2">{sheetCard}</div>}
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
				{!sheet && !minimized && hasSurface && (
					<button
						type="button"
						data-testid="bar-strip"
						onClick={() => openSheet(cards.pending.length > 0)}
						className="flex min-h-11 w-full items-center justify-between gap-2 border-b px-3 text-left font-ui text-sm hover:bg-accent"
					>
						<span className="truncate">{cards.pending.length > 0 ? (cards.pending.length === 1 ? "1 card waiting" : `${cards.pending.length} cards waiting`) : cards.error ? "Could not send. Tap to see" : cards.superseded.length > 0 ? "Replied instead. Tap to see" : "New reply. Tap to read"}</span>
						<ChevronUpIcon className="size-4 shrink-0 text-muted-foreground" />
					</button>
				)}
				{!minimized && !sheet && chipRow}
				<div className="relative flex items-center gap-1 px-1.5">
					{chip}
					{sheet && badge}
					{working && <span data-testid="chat-bar-working" className="font-ui text-xs text-muted-foreground">working…</span>}
					<div className="ml-auto flex items-center">
						{!sheet && (
							<button type="button" aria-label="Open full screen" data-testid="bar-sheet-open" onClick={() => openSheet(false)} className={tap}>
								<ChevronUpIcon className="size-5" />
							</button>
						)}
						<BarSettings wolf={target.wolf} slug={target.slug} phone buttonClass={tap} />
						<Hint label="Minimize">
							<button type="button" aria-label="Minimize chat bar" data-testid="chat-bar-minimize" onClick={() => setMinimized(true)} className={tap}>
								<ChevronDownIcon className="size-4" />
							</button>
						</Hint>
					</div>
				</div>
				{!minimized && (api.closedReason !== undefined ? <BarClosedNotice target={target} reason={api.closedReason} /> : composing ? null : <BarComposer phone target={target} onSending={setSending} title={vizOn ? target.wolf : title} cardOpen={pendingCount > 0} askOpen={!!askCard} onReplied={cards.replied} dictation={dictation} registerAppend={registerAppend} session={askCard ? session : undefined} registerNoteSink={registerNoteSink} />)}
				{BAR_EXTRAS.switcher && switcher && !vizOn && <Switcher groups={groups} current={target} onClose={closeSwitcher} sheet />}
			</div>
			</>
		);
	}

	// The header's secondary controls: inline on a wide column, inside the ⋯ menu on a narrow one (where the swap pill joins them).
	const deskControls = (
		<>
			<BarSettings wolf={target.wolf} slug={target.slug} phone={false} buttonClass="rounded-md p-1 text-muted-foreground hover:bg-accent" />
			{!swap && (
				<Hint label="Minimize">
					<button type="button" aria-label="Minimize chat bar" data-testid="chat-bar-minimize" onClick={() => setMinimized(true)} className="rounded-md p-1 text-muted-foreground hover:bg-accent">
						<ChevronDownIcon className="size-4" />
					</button>
				</Hint>
			)}
			{compact && swap && (
				<Hint label={swapLabel}>
					<button
						type="button"
						data-testid="chat-bar-swap"
						data-needs-you={swapNeedsYou ? "true" : undefined}
						aria-label={swapLabel}
						disabled={sending}
						onClick={() => void (!sending && afterBarDictation(() => api.attach({ wolf: swap.wolf, threadId: swap.threadId, slug: swap.slug })))}
						className={cn("rounded-md p-1 text-muted-foreground hover:bg-accent", swapNeedsYou && "text-amber-600 dark:text-amber-400")}
					>
						{swapNeedsYou ? <MessageCircleQuestionIcon aria-hidden className="size-4" /> : <ArrowLeftRightIcon aria-hidden className="size-4" />}
					</button>
				</Hint>
			)}
		</>
	);

	return (
		<div ref={wrapRef} data-testid="chat-bar" data-state="open" data-compact={compact ? "true" : undefined} data-docked={docked ? "true" : undefined} className={docked ? "relative w-full" : "fixed bottom-3 z-30 -translate-x-1/2"} style={docked ? undefined : { left: geo.left, width: geo.width }}>
			{swapPill}
			{/* Card surface slot (PtJkpk6): the thread's pending question cards and the last-reply peek mount here, above the input. */}
			<div data-slot="chat-bar-card-surface" data-testid="chat-bar-card-surface" className={cn("empty:hidden", askCard && session.expanded ? "" : "mb-2")}>
				{sheetCard}
				{hasSurface && <BarCardSurface key={`${target.wolf}:${target.threadId}`} target={target} cards={cards} />}
			</div>
			<div className={cn("relative rounded-2xl border bg-card shadow-lg", askCard && session.expanded ? "rounded-t-none border-t-0" : "focus-within:ring-1 focus-within:ring-(color:--thread-accent)")} style={composing ? undefined : { borderColor: color }}>
				{chipRow}
				<div className="flex items-center gap-1 px-1.5 pt-1">
					{chip}
					{working && <span data-testid="chat-bar-working" className="font-ui text-xs text-muted-foreground">working…</span>}
					<div className="ml-auto flex items-center gap-0.5">{compact ? <BarOverflow>{deskControls}</BarOverflow> : deskControls}</div>
				</div>
				{api.closedReason !== undefined ? <BarClosedNotice target={target} reason={api.closedReason} /> : composing ? null : <BarComposer target={target} onSending={setSending} title={title} cardOpen={pendingCount > 0} askOpen={!!askCard} onReplied={cards.replied} dictation={dictation} registerAppend={registerAppend} session={askCard ? session : undefined} registerNoteSink={registerNoteSink} />}
				{BAR_EXTRAS.switcher && switcher && !vizOn && <Switcher groups={groups} current={target} onClose={closeSwitcher} />}
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

/** A pending owner approval as GET /api/needs-you lists it. */
export interface ApprovalEntry { requestId: string; workId: string; label: string; href: string }

/** The pending owner approvals: fetched once, refetched on needs-you-changed and work-request-changed (no polling). */
function useApprovalEntries(enabled: boolean): ApprovalEntry[] {
	const [list, setList] = useState<ApprovalEntry[]>([]);
	const seq = useRef(0);
	const load = useCallback(() => {
		if (!enabled) return;
		const n = ++seq.current;
		void (async () => {
			try {
				const res = await fetch("/api/needs-you", { cache: "no-store" });
				if (!res.ok || n !== seq.current) return;
				const body = (await res.json()) as { approvals?: ApprovalEntry[] };
				if (n === seq.current && Array.isArray(body.approvals)) setList(body.approvals);
			} catch {
				/* keep the last list */
			}
		})();
	}, [enabled]);
	useEffect(() => load(), [load]);
	useOptionalServerEvent("needs-you-changed", load);
	useOptionalServerEvent("work-request-changed", load);
	return list;
}

/** Another thread has a card waiting: count + that thread's color dot. One tap attaches the bar to the oldest waiting one (no toast, no auto-switch). */
export function NeedsYouBadge({ waiting, all, approvals }: { waiting: (BarThread & { wolf: string })[]; all: BarThread[]; approvals: ApprovalEntry[] }) {
	const api = useAttachedThread()!;
	const router = useRouter();
	const first = waiting[0];
	const color = useThreadColor(first ? { id: first.id, ...(first.kind ? { kind: first.kind } : {}), ...(first.parentThreadId ? { parentThreadId: first.parentThreadId } : {}) } : { id: "" }, all, first ? api.wolves.find((w) => w.name === first.wolf)?.color : undefined).hex;
	const total = waiting.length + approvals.length;
	return (
		<span className="flex shrink-0 items-center gap-1">
			<button
				type="button"
				data-testid="chat-bar-needs-you"
				data-thread={first?.id}
				title={first ? `${total} waiting for you · oldest: ${first.title}` : `${total} waiting for you · ${approvals[0]!.label}`}
				aria-label={first ? `${total} waiting for you. Attach the bar to ${first.title}` : `${total} waiting for you. Open ${approvals[0]!.label}`}
				onClick={() => (first ? api.attach({ wolf: first.wolf, threadId: first.id }) : router.push(approvals[0]!.href))}
				className="flex shrink-0 items-center gap-1 rounded-full border border-amber-500/40 bg-card px-2.5 py-1 font-ui text-xs text-amber-400 hover:bg-accent max-md:min-h-11"
			>
				<span className="size-1.5 rounded-full" style={{ backgroundColor: color }} />
				{total}
			</button>
			{approvals.slice(0, 2).map((a) => (
				<button key={a.requestId} type="button" data-testid="chat-bar-approval" title={a.label} onClick={() => router.push(a.href)} className="max-w-[12rem] shrink-0 truncate rounded-full border border-amber-500/40 bg-card px-2.5 py-1 font-ui text-xs text-amber-400 hover:bg-accent max-md:min-h-11">
					{a.label}
				</button>
			))}
		</span>
	);
}

/**
 * The wolf and thread switcher, opened from the chip (the wolf's name): wolves with status dots and their threads, the ones waiting on the owner first with an amber count.
 * A compact popover on desktop, a bottom sheet (rows of at least 44px) on the phone. A dialog: focus moves in, arrows walk the entries, Esc / outside click close and return focus to the chip.
 * The footer opens the attached wolf's visualizations, and the attached thread's own page.
 */
export function Switcher({ groups: liveGroups, current, onClose, sheet = false }: { groups: SwitcherGroup[]; current: Pick<AttachedRef, "wolf" | "threadId">; onClose: () => void; sheet?: boolean }) {
	// The order is frozen while it is open (nothing jumps under the pointer); statuses and counts stay live, and the next open re-sorts.
	const [frozen] = useState(() => switcherOrder(liveGroups));
	const groups = useMemo(() => inFrozenOrder(liveGroups, frozen), [liveGroups, frozen]);
	const api = useAttachedThread();
	const router = useRouter();
	const frames = useFrameBadges(current.wolf, current.threadId);
	const ref = useRef<HTMLDivElement | null>(null);
	const items = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('[data-testid="switcher-entry"], [data-testid="switcher-action"]:not(:disabled)') ?? []);
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
	// eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only listener: the parent's closeSwitcher is a useCallback with [] deps, so the mount-render onClose never goes stale
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
	const row = cn("flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none", sheet && "min-h-11");
	// Leaving for the thread page waits for a running dictation to finish first (so its words land in the draft), like the chip used to.
	const threadHere = (vizOn = false) =>
		afterBarDictation(() => {
			// Visualization mode is the stored per-thread choice; the thread page reads it on arrival (viz-mode.ts).
			if (vizOn) setVizMode(current.wolf, current.threadId, true);
			onClose();
			router.push(threadHref(current.wolf, current.threadId));
		});
	const visualizations = () => threadHere(true);
	return (
		<>
		{sheet && <button type="button" tabIndex={-1} aria-label="Close" data-testid="switcher-backdrop" onClick={onClose} className="fixed inset-0 z-[49] bg-black/40 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200" />}
		<div ref={ref} role="dialog" aria-label="Switch wolf or thread" tabIndex={-1} onKeyDown={onKeyDown} data-testid="chat-bar-switcher" data-layout={sheet ? "sheet" : "popover"} className={cn("z-50 overflow-y-auto border bg-popover/95 p-1 outline-none backdrop-blur-xl motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150", sheet ? "fixed inset-x-0 bottom-0 max-h-[70dvh] rounded-t-2xl border-b-0 pb-[env(safe-area-inset-bottom)] shadow-2xl motion-safe:slide-in-from-bottom-4" : "absolute bottom-full left-0 z-40 mb-2 max-h-80 w-72 rounded-xl shadow-lg motion-safe:zoom-in-95")}>
			{sheet && (
				<div className="flex min-h-11 items-center justify-between">
					<span aria-hidden className="ml-2 h-1 w-10 rounded-full bg-muted-foreground/40" />
					<button type="button" aria-label="Close" data-testid="switcher-close" onClick={onClose} className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-muted-foreground hover:bg-accent">
						<ChevronDownIcon className="size-5" />
					</button>
				</div>
			)}
			{groups.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">No threads yet.</p>}
			{groups.map((g) => (
				<div key={g.wolf} role="group" aria-label={g.wolf} data-testid="switcher-group" data-wolf={g.wolf} data-needs-you={g.needsYou > 0 ? g.needsYou : undefined}>
					<p className="flex items-center gap-1.5 px-2 pt-1.5 font-ui text-[10px] uppercase tracking-wide text-muted-foreground">
						<span role="img" aria-label={g.status === "offline" ? "offline" : "online"} data-testid="switcher-wolf-dot" data-status={g.status} className={cn("size-1.5 shrink-0 rounded-full", g.status === "offline" ? "bg-muted-foreground/40" : "bg-emerald-500")} />
						<span className="min-w-0 flex-1 truncate">{g.wolf}</span>
						{g.needsYou > 0 && <span data-testid="switcher-wolf-count" aria-label={`${g.needsYou} waiting for you`} className="rounded-full bg-amber-500/15 px-1.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">{g.needsYou}</span>}
					</p>
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
							className={cn(row, e.wolf === current.wolf && e.threadId === current.threadId && "bg-accent")}
						>
							<span className="min-w-0 flex-1 truncate">{e.title}</span>
							{e.needsYou && <span role="img" aria-label="waiting on you" data-testid="switcher-entry-waiting" className="size-2 shrink-0 rounded-full bg-amber-500" />}
							{!e.needsYou && e.status === "busy" && <BrailleSpinner />}
						</button>
					))}
				</div>
			))}
			<div role="group" aria-label="Actions" className="mt-1 border-t pt-1">
				<button type="button" data-testid="switcher-action" data-action="visualizations" disabled={frames.length === 0} onClick={visualizations} className={cn(row, "disabled:opacity-40")}>
					<EyeIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
					<span className="min-w-0 flex-1 truncate">Open visualizations</span>
					{frames.length > 0 && <span className="font-ui text-[10px] text-muted-foreground">{frames.length}</span>}
				</button>
				<button type="button" data-testid="switcher-action" data-action="open-thread" onClick={() => threadHere()} className={row}>
					<MessageSquareIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
					<span className="min-w-0 flex-1 truncate">Open thread page</span>
				</button>
			</div>
		</div>
		</>
	);
}
