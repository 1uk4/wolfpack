"use client";

// Must stay the first import: copies the pre-rename localStorage keys before any read.
import "@/src/core/legacy-storage-boot.ts";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { MenuShell } from "@/components/menu-shell";
import { DeleteSessionDialog } from "@/components/delete-session-dialog";
import { ArrowLeftIcon, ChevronDownIcon, ChevronRightIcon, NetworkIcon, WorkflowIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, PlusIcon, SearchIcon, SettingsIcon, FileTextIcon } from "lucide-react";
import { ActivitySection } from "@/components/activity-dock";
import { useSubagentModal } from "@/components/subagent-modal";
import { NeedsYouNotifier, NotifyToggle } from "@/components/needs-you";
import { WolfpackMark } from "@/components/wolfpack-mark";
import { BrailleSpinner } from "@/components/braille-spinner";
import { ChatBar } from "@/components/chat-bar";
import { WorkReaderHost } from "@/components/work-reader";
import { KeyboardShortcuts } from "@/components/keyboard-shortcuts";
import { shouldOpenInReader, useOpenWorkItem } from "@/components/work-reader-nav";
import { WorkNavEntry } from "@/components/work-nav-link";
import { CommandPalette } from "@/components/command-palette";
import { SettingsDialogProvider, useSettingsDialog } from "@/components/settings/settings-dialog.tsx";
import { Hint } from "@/components/ui/hint";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { coalescedRefresh, checkRoster, foldWolfRoster, foldWolfThreads, startVisibleTimer, type WolfStatus, fuzzyScore, initialListOpen, listOpenAfterSelect, MOBILE_BACK_LABEL, MOBILE_QUERY, needsFloatingBack } from "@/src/core";
import { ThreadColorPicker } from "@/components/thread-color-picker";
import { settingsUrl } from "@/components/thread-transport";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { THREAD_COLORS, autoThreadColor, beginColorChange, onThreadColor, pendingColor, settleColorChange, threadColor, threadColorIndex, threadColorVersion, threadAccentStyle, threadSlug, isChildThread, isLive, rowWolf, sidebarLayout, stateLabel, threadListItem, type ChatListItem, type ChildThread, workHref } from "@/src/core";

/** A sidebar row: a chat-shaped item that may carry the route it opens and
 *  its own meta line (thread rows — the ConsoleClient list). */
type SessionItem = ChatListItem & { href?: string; meta?: string; needsYou?: boolean; archived?: boolean; kind?: string; alias?: string; branch?: string; color?: string } & Omit<ChildThread, "id" | "title">;

const itemHref = (c: SessionItem) => c.href ?? `/chat/${c.id}`;
import { kbdEventForAction } from "@/src/core";

/**
 * Toggleable sidebar — NOT a modal drawer: no backdrop, no focus theft. It
 * sits inline next to the content and can stay open while working in a
 * session. Open state persists across pages (provider lives in the root
 * layout) and across reloads (localStorage).
 */

const STORAGE_KEY = "wolfpack:sidebar-open";

/*
 * Narrow-window behavior (owner, 2026-09-17): below SIDEBAR_AUTOCLOSE the
 * sidebar would squeeze the page below the 640px window floor (the two
 * numbers compose: 640 + 288 sidebar = 928), so it auto-closes — and
 * auto-RESTORES when the window widens again (owner choice: the sidebar
 * pops back, not a manual re-open). The whole behavior is one expression:
 * rendered = pref && !narrow, where pref is the persisted user choice.
 * Manual closes persist and stay closed; auto-close does not touch the
 * preference. Opening the sidebar while narrow asks the Electron shell to
 * widen the window to the threshold (window.wolfpack.expandWindow, IPC in
 * electron/main.cjs) — the resize listener flips `narrow` and the sidebar
 * appears. In the plain browser there is no window to widen and no
 * suppression — a narrow tab opens the sidebar if the user says so.
 *
 * Mirrors SIDEBAR_AUTOCLOSE in electron/main.cjs — keep in sync.
 */
const SIDEBAR_AUTOCLOSE = 928;

// Module scope, guarded for SSR (the server has no navigator).
const IS_ELECTRON = typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");

type DesktopBridgeApi = {
	/** Read-only host OS; determines the native-control gutter. */
	platform?: string;
	expandWindow: () => void;
	/** The zoom truth (owner round 7): subscribes to "wolfpack:zoom" pushes; returns unsubscribe. */
	onZoom?: (cb: (factor: number) => void) => () => void;
	getZoom?: () => Promise<number>;
	/** Auto-update channel (Wave C, 2026-10-10): "wolfpack:update-status" pushes once a staged update exists. */
	onUpdateStatus?: (cb: (status: { status: string; version: string | null }) => void) => () => void;
	installUpdate?: () => void;
	/** Needs-you notification (ticket 4): main shows it only while the window is unfocused, once per `key`. */
	notify?: (n: { key: string; title: string; body: string; href: string }) => void;
	/** The OS notification was clicked: main focused the window; open this href. Returns unsubscribe. */
	onNavigate?: (cb: (href: string) => void) => () => void;
};

declare global {
	interface Window {
		/** Preload bridge (electron/preload.cjs) — Electron only, absent in the browser. */
		wolfpack?: DesktopBridgeApi;
		lh?: DesktopBridgeApi; // legacy window.lh shim, remove after the next desktop release
	}
}

/** The desktop preload bridge: `window.wolfpack`, or the old preload's legacy global. */
export const desktopBridge = (): DesktopBridgeApi | undefined =>
	typeof window === "undefined" ? undefined : (window.wolfpack ?? window.lh); // legacy window.lh shim, remove after the next desktop release

const SidebarContext = createContext<{ open: boolean; toggle: () => void; mobile: boolean; closeList: () => void; registerToggle: () => () => void }>({
	open: false,
	toggle: () => {},
	mobile: false,
	closeList: () => {},
	registerToggle: () => () => {},
});

export function useSidebar() {
	return useContext(SidebarContext);
}

export function SidebarProvider({ children }: { children: React.ReactNode }) {
	// Start closed so server and client first-render agree (no hydration
	// mismatch); the stored value is applied after mount.
	const [open, setOpen] = useState(false);
	const [narrow, setNarrow] = useState(false);
	const [mounted, setMounted] = useState(false);
	// Phone (< 768px): the sidebar is the full-screen LIST layer, not a persisted side panel (see src/core/mobile-layout.ts).
	const [mobile, setMobile] = useState(false);
	const [toggles, setToggles] = useState(0);
	const pathname = usePathname();
	const pathRef = useRef(pathname);
	pathRef.current = pathname;

	useEffect(() => {
		// Electron shell detection (merged chrome, 2026-09-17): keys the
		// .wp-electron CSS (app/globals.css) that turns the header bands
		// into the window's drag surface. Post-mount only — server HTML
		// and first client render must agree (no hydration mismatch),
		// and in the plain browser the class never appears.
		if (IS_ELECTRON) {
			document.documentElement.classList.add("wp-electron");
			document.documentElement.dataset.wpPlatform = desktopBridge()?.platform ?? "";
		}

		// THE ZOOM TRUTH (owner round 7, 2026-10-05): ⌘±/⌘0 zoom the UI
		// (Electron zoomFactor) while the native traffic lights stay
		// physical-fixed — the CSS gutter lengths divide by this factor so
		// their RENDERED size never moves. getZoom covers the first-paint
		// race; every later change arrives as an wolfpack:zoom push.
		const setZoomVar = (factor: number) =>
			document.documentElement.style.setProperty("--wp-zoom", String(factor));
		const off = desktopBridge()?.onZoom?.(setZoomVar);
		void desktopBridge()?.getZoom?.().then(setZoomVar);

		// Default: open (first run introduces the sidebar). A phone starts on the list at "/".
		const mq = typeof window.matchMedia === "function" ? window.matchMedia(MOBILE_QUERY) : null; // absent in the DOM test shims
		// This effect runs once, so `pathname` here is the FIRST render's value (deliberately: it only decides the initial state);
		// later reads go through pathRef, which tracks the current route.
		const apply = (path: string) => {
			const isMobile = mq?.matches ?? false;
			setMobile(isMobile);
			setOpen(initialListOpen(isMobile, localStorage.getItem(STORAGE_KEY), path));
		};
		apply(pathname ?? "/");
		setMounted(true);
		// Rotation / resize across 768px: recompute (back to >= 768 restores the stored desktop preference).
		const onMq = () => apply(pathRef.current ?? "/");
		mq?.addEventListener("change", onMq);
		return () => {
			off?.();
			mq?.removeEventListener("change", onMq);
		};
	}, []);

	// Selecting something in the list on a phone closes it (never persisted); called from the click handlers.
	const closeList = useCallback(() => setOpen((o) => listOpenAfterSelect(mobile, o)), [mobile]);
	const registerToggle = useCallback(() => {
		setToggles((n) => n + 1);
		return () => setToggles((n) => n - 1);
	}, []);

	// Narrow-window auto-close/auto-restore (see SIDEBAR_AUTOCLOSE note):
	// fires only on actual resizes — a boolean compare, no layout work.
	// Both this and the mount effect land before the first paint, so a
	// narrow window never flashes the open sidebar on load.
	useEffect(() => {
		if (!IS_ELECTRON) return; // plain-browser tabs open freely
		const onResize = () => setNarrow(window.innerWidth < SIDEBAR_AUTOCLOSE);
		onResize();
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	const toggle = useCallback(() => {
		// Opening while narrow (auto-closed, or the user's own closed-at-
		// narrow): ask the shell to widen to the threshold — the resize
		// listener flips `narrow` and the sidebar appears. The preference
		// persists like any other open, so a restart at a narrow width
		// still auto-restores when widened.
		if (narrow && !open) {
			localStorage.setItem(STORAGE_KEY, "0");
			setOpen(true);
			desktopBridge()?.expandWindow();
			return;
		}
		if (mobile) return setOpen((v) => !v); // a phone's list layer is transient: no persisted preference
		setOpen((v) => {
			localStorage.setItem(STORAGE_KEY, v ? "0" : "1");
			return !v;
		});
	}, [narrow, open, mobile]);

	// ⌘B: the global shortcut dispatches kbdEventForAction("toggle-sidebar")
	// and the context answers on exactly that name — the shared spelling
	// is the fix for the interlude bug (the listener sat on the pre-
	// convention name "wolfpack:toggle-sidebar" while the dispatcher sent
	// "wolfpack:kbd-toggle-sidebar", so ⌘B silently did nothing; owner
	// 2026-09-25).
	useEffect(() => {
		const event = kbdEventForAction("toggle-sidebar");
		const onToggle = () => toggle();
		window.addEventListener(event, onToggle);
		return () => window.removeEventListener(event, onToggle);
	}, [toggle]);

	return (
		<SidebarContext.Provider value={{ open: open && !narrow, toggle, mobile, closeList, registerToggle }}>
			{/* transitions gated on mount: no slide-in flash on page load */}
			{/* phone: the shell owns the top safe-area inset (pages without a header must not draw under the notch) */}
			<div data-wp-shell className={cn("flex h-dvh max-md:pt-[env(safe-area-inset-top)]", mounted && "[&_.sidebar-motion]:transition-[width,margin,opacity]")}>{children}</div>
			<FloatingBack toggles={toggles} open={open && !narrow} mobile={mobile} onClick={toggle} />
		</SidebarContext.Provider>
	);
}

/** Phone only: a fixed back-to-list button for pages that render no SidebarToggle (graph "/", KB activity). */
function FloatingBack({ toggles, open, mobile, onClick }: { toggles: number; open: boolean; mobile: boolean; onClick: () => void }) {
	if (!needsFloatingBack(mobile, open, toggles)) return null;
	return (
		<button
			type="button"
			aria-label={MOBILE_BACK_LABEL}
			data-testid="mobile-back"
			onClick={onClick}
			className="fixed left-2 z-30 flex size-11 items-center justify-center rounded-full border bg-card/90 text-muted-foreground shadow-lg backdrop-blur"
			style={{ top: "calc(env(safe-area-inset-top) + 0.5rem)" }}
		>
			<ArrowLeftIcon className="size-5" />
		</button>
	);
}

/** Hamburger for page headers — only visible when the sidebar is closed.
 *
 *  Owner, round 6c: the toggle is ALWAYS MOUNTED, owning a slot whose
 *  width+margin animate in LOCKSTEP with the sidebar's own width
 *  transition (same duration-200, same easing, both gated on mount) —
 *  before, it mounted/unmounted in one frame, so its 48px footprint
 *  (button + gap) popped and dragged the title and chips sideways while
 *  the sidebar was still mid-slide. When open the slot is exactly zero
 *  (w-0 -mr-3: width 0, the negative margin cancels the header's gap-3),
 *  so resting layouts are pixel-identical to the old conditional render.
 *  The icon fades with the slot and is clipped by it as it collapses —
 *  no popping in either direction. */
export function SidebarToggle() {
	const { open, toggle, mobile, registerToggle } = useSidebar();
	useEffect(() => registerToggle(), [registerToggle]);
	// Phone: the clear back control (list <- content). Plain 44px button, no slot animation.
	if (mobile) {
		return (
			<button
				type="button"
				aria-label={MOBILE_BACK_LABEL}
				data-testid="mobile-back"
				onClick={toggle}
				className="flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
			>
				<ArrowLeftIcon className="size-5" />
			</button>
		);
	}
	return (
		<span
			className={cn(
				"sidebar-motion wp-no-drag relative flex h-9 shrink-0 overflow-hidden duration-200",
				open ? "w-0 -mr-3" : "w-9 mr-0 wp-closed-toggle",
			)}
		>
			<Hint label="Open sidebar" action="toggle-sidebar">
			<Button
				variant="ghost"
				size="icon"
				aria-label="Open sidebar"
				aria-hidden={open}
				tabIndex={open ? -1 : 0}
				onClick={toggle}
				className={cn("sidebar-motion duration-200", open ? "pointer-events-none opacity-0" : "opacity-100")}
			>
				{/* Owner, round 6: size-4, SAME as the close glyph — the toggle
				    must not grow when the sidebar is closed (it did: size-5 here).
				    The small look is the standard, both directions. */}
				<PanelLeftOpenIcon className="size-4" />
			</Button>
			</Hint>
		</span>
	);
}

/**
 * The row's status indicator (owner, minimal-color round): the braille
 * spinner, ONLY while a turn is in flight — monochrome motion, the
 * terminal's own glyph, existing exactly as long as the work does and
 * vanishing the moment it ends. Every other state renders NOTHING:
 * question-pending is the dominant RESTING state of real sessions — a
 * resting state has no scan value, so the meta line's "Waiting for input"
 * text carries it. Idle is the absence of a signal, by design.
 */
function SessionStatus({ busy }: { busy: boolean }) {
	if (!busy) return null;
	return <BrailleSpinner />;
}

/** Compact "how long ago": "just now", "5m ago", "3h ago", "2d ago",
 *  then a plain date. How long a session has been WAITING matters more
 *  than an absolute timestamp. Beyond a week the date renders ISO
 *  (YYYY-MM-DD, zero-padded) — the international standard: unambiguous
 *  in any locale and it sorts (owner, typography round 5; the old
 *  M/D/YYYY was the US convention. A user-locale setting can come later
 *  — trivial, a format function swap). Pure — exported for tests. */
export function timeAgo(iso: string, now = new Date()): string {
	const ms = now.getTime() - new Date(iso).getTime();
	if (ms < 60_000) return "just now";
	const min = Math.floor(ms / 60_000);
	if (min < 60) return `${min}m ago`;
	const h = Math.floor(min / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	if (d < 7) return `${d}d ago`;
	const date = new Date(iso);
	const mm = String(date.getMonth() + 1).padStart(2, "0");
	const dd = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${mm}-${dd}`;
}

/** The row's second line: the state when a state exists (waiting/working),
 *  otherwise just how long ago. The message count is DROPPED (owner,
 *  typography round 5): it informed no decision — clutter. messageCount
 *  still rides the API payload, so this is a one-line flip back if it's
 *  ever wanted. */
function sessionMeta(chat: SessionItem): string {
	// A subagent: its agent and state (a running one also says what it is doing).
	if (chat.parentThreadId !== undefined && chat.state !== undefined) {
		const step = chat.state === "running" && chat.step ? ` · ${chat.step}` : "";
		return `${chat.agent ?? "agent"} · ${stateLabel(chat)}${step}`;
	}
	// A feature thread names its git branch where other rows name the wolf (the orchestrator row carries the wolf).
	const who = chat.kind === "feature" ? chat.branch : chat.meta;
	if (chat.meta !== undefined && !chat.busy && !chat.needsYou) return who ?? "";
	if (chat.compacting) return `Compacting context · ${timeAgo(chat.updatedAt)}`;
	if (chat.needsYou) return who !== undefined ? `${who} · needs you` : "Needs you";
	if (chat.pendingQuestion) return `Waiting for input · ${timeAgo(chat.updatedAt)}`;
	if (chat.busy) return "Working…";
	return timeAgo(chat.updatedAt);
}

/**
 * One session row: the status spinner (only while working), then title +
 * state-aware meta. Exported for render tests — pure function of the
 * list item.
 */
export function SessionRow({
	chat,
	active,
	onOpen,
	kbdSelected = false,
	onContextMenu,
	nested = false,
	indented = false,
	offline = false,
	wolfStatus,
	dotColor,
}: {
	chat: SessionItem;
	/** The thread's color (hex) for the dot: its override, else the id's, a subagent's = its parent's. */
	dotColor?: string;
	/** The wolf's liveness, drawn as a badge on its group header (the Home row). */
	wolfStatus?: WolfStatus;
	/** Its wolf is offline: the row we still hold is greyed and says so. */
	offline?: boolean;
	/** A subagent row under its feature: two steps in, compact single line. */
	nested?: boolean;
	/** A feature thread (or archived one) under Home: one step in, with a left guide line. */
	indented?: boolean;
	active: boolean;
	onOpen: () => void;
	/** Keyboard-cycle highlight (shortcut wave A: Alt+↑/↓ + Alt+Enter) —
	 *  visually distinct from the active session, which stays filled. */
	kbdSelected?: boolean;
	/** Right-click opens the context menu (wave 6: Rename / Delete). */
	onContextMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
	const openWorkItem = useOpenWorkItem();
	// The thread you are looking at needs no mark: you are already there.
	if (active && chat.needsYou) chat = { ...chat, needsYou: false };
	const home = chat.kind === "home";
	if (nested) {
		// Compact subagent row: `name · agent`, one line. The braille glyph in front animates only while running
		// (waiting/queued: the same glyph at rest, muted). The task it serves is a small link at the end.
		const running = chat.state === "running";
		return (
			<div
				title={offline ? "offline" : undefined}
				style={threadAccentStyle(dotColor) as CSSProperties}
				className={cn(
					offline && "opacity-50",
					"relative mb-px ml-8 flex w-[calc(100%-2rem)] items-center gap-1.5 rounded-md border-l border-border pl-2 pr-2 text-xs leading-5 text-muted-foreground transition-colors hover:bg-accent",
					active && "bg-accent text-foreground shadow-[inset_2px_0_0_var(--thread-accent)]",
					kbdSelected && !active && "bg-accent/60 ring-1 ring-border",
				)}
			>
				<button
					type="button"
					onClick={onOpen}
					onContextMenu={onContextMenu}
					data-testid={kbdSelected ? "session-row-kbd" : "session-row"}
					data-compact="true"
					data-state={chat.state ?? ""}
					title={sessionMeta(chat)}
					className="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 text-left"
				>
					{dotColor && <span data-testid="thread-color-dot" aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: dotColor }} />}
					{running ? (
						<BrailleSpinner className="h-[1.25em] text-foreground" label={stateLabel(chat)} />
					) : (
						<BrailleSpinner still className="h-[1.25em] text-muted-foreground/60" label={stateLabel(chat)} />
					)}
					<span className="min-w-0 flex-1 truncate">
						<span className="font-prose">{chat.title}</span>
						<span> · {chat.agent ?? "agent"}</span>
					</span>
				</button>
				{chat.taskId && (
					<Link href={workHref(chat.taskId)} onClick={(e) => { if (!shouldOpenInReader(e, chat.taskId)) return; e.preventDefault(); openWorkItem(chat.taskId); }} data-testid="subagent-task-link" aria-label={`Open task for ${chat.title}`} title="Open the task this serves" className="shrink-0 underline-offset-2 hover:underline">
						task
					</Link>
				)}
			</div>
		);
	}
	return (
		<button
			type="button"
			onClick={onOpen}
			onContextMenu={onContextMenu}
			data-testid={kbdSelected ? "session-row-kbd" : "session-row"}
			data-offline={offline || undefined}
			title={offline ? "offline" : undefined}
			aria-label={offline ? `${chat.title} (offline)` : undefined}
			style={threadAccentStyle(dotColor) as CSSProperties}
			className={cn(
				offline && "opacity-50",
				"relative mb-0.5 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-accent",
				indented && "ml-4 w-[calc(100%-1rem)] border-l border-border rounded-l-none",
				active && "bg-accent shadow-[inset_2px_0_0_var(--thread-accent)]",
				kbdSelected && !active && "bg-accent/60 ring-1 ring-border",
			)}
		>
			{dotColor && <span data-testid="thread-color-dot" aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: dotColor }} />}
			<SessionStatus busy={chat.busy || chat.compacting || chat.state === "running"} />
			{chat.needsYou && !chat.busy && (
				// A wolf is waiting on an answer: the one resting state that earns a mark (it needs the operator).
				<span data-testid="needs-you-dot" role="img" aria-label="Needs you" className="size-2 shrink-0 rounded-full bg-primary" />
			)}
			<span className="min-w-0 flex-1">
				{/* Titles are human WORDS — Source Sans 3, the
				    same voice the words were typed in (every input is wp-prose);
				    the meta line below stays JetBrains Mono (machine data). One
				    rule, finally applied to the picker too (owner, typography
				    round): mono = chrome, Source Sans = human words. */}
				<span className="flex items-center gap-1.5 truncate font-prose text-(length:--wp-prose-size)">
					{home && <WorkflowIcon data-testid="orchestrator-icon" aria-label="Orchestrator" className="size-[1em] shrink-0 text-muted-foreground" />}
					<span className="truncate">{chat.title}</span>
				</span>
				{(() => {
					// Home says "orchestrator" only when idle; Working… / needs you win when they apply.
					const meta = home && !chat.busy && !chat.needsYou && !chat.compacting && !chat.pendingQuestion ? "orchestrator" : sessionMeta(chat);
					// Nothing to say (a feature without a branch): no line, so no empty gap.
					return meta ? (
						<span data-testid="session-meta" title={chat.branch && chat.kind === "feature" ? chat.branch : undefined} className="block truncate text-xs text-muted-foreground">{meta}</span>
					) : null;
				})()}
			</span>
			{home && wolfStatus && <WolfBadge wolf={wolfStatus} />}
		</button>
	);
}

/** The inline-rename row (wave 6): same geometry as SessionRow, but the
 *  title line becomes a text input — select-all on entry (the click means
 *  "replace", the header rename's rule), Enter/blur commits, Esc discards.
 *  The meta line stays so the row never changes height mid-edit. */
export function RenameRow({ chat, onCommit, onCancel }: { chat: ChatListItem; onCommit: (next: string) => void; onCancel: () => void }) {
	const [draft, setDraft] = useState(chat.title);
	const inputRef = useRef<HTMLInputElement | null>(null);
	useEffect(() => {
		const el = inputRef.current;
		if (el) {
			el.focus();
			el.select();
		}
	}, []);
	return (
		<div
			data-testid="session-rename-row"
			className="relative mb-0.5 flex w-full items-center rounded-lg bg-accent px-3 py-2"
		>
			{/* NOTHING MOVES (owner, polish round): an idle row renders no
			    status spacer (SessionStatus is null when not busy), so the
			    title starts at the row's own px-3 — 12px in. The old rename
			    row always carried a 14px spacer + gap + the input's border
			    and padding, landing the text ~41px in (and the meta with
			    it). The input here is borderless and padding-free at the
			    exact title x; the underline is the only editing cue. */}
			<span className="flex min-w-0 w-full flex-col">
				<input
					ref={inputRef}
					value={draft}
					spellCheck={false}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={() => onCommit(draft)}
					onKeyDown={(e) => {
						if (e.key === "Enter") e.currentTarget.blur();
						if (e.key === "Escape") {
							e.stopPropagation(); // discard, not also the sidebar/chat chains
							onCancel();
						}
					}}
					aria-label="Rename session"
					data-testid="session-rename-input"
					className="wp-input w-full min-w-0 truncate border-0 border-b border-border bg-transparent px-0 text-foreground outline-none"
				/>
				<span className="block truncate text-xs text-muted-foreground">{sessionMeta(chat)}</span>
			</span>
		</div>
	);
}

/** The wolf's liveness on its own group header: a dot plus an explicit word (never colour-only). Compact on phones. */
export function WolfBadge({ wolf }: { wolf: WolfStatus }) {
	return (
		<span
			data-testid="wolf-badge"
			data-wolf={wolf.name}
			data-online={wolf.online}
			role="status"
			aria-label={`${wolf.name}, ${wolf.online ? "online" : "offline"}`}
			className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
		>
			<span aria-hidden className={cn("size-2 rounded-full", wolf.online ? "bg-emerald-500" : "bg-muted-foreground/40")} />
			<span aria-hidden>{wolf.online ? "online" : "offline"}</span>
		</span>
	);
}

/** Header for a known wolf with no Home thread held (zero threads, or only features): same look as the Home row. */
export function WolfHeaderRow({ wolf }: { wolf: WolfStatus }) {
	return (
		<div data-testid="wolf-header" data-wolf={wolf.name} className={cn("mb-0.5 flex w-full items-center gap-2 rounded-lg px-3 py-2", !wolf.online && "opacity-50")}>
			<span className="min-w-0 flex-1">
				<span className="flex items-center gap-1.5 truncate font-prose text-(length:--wp-prose-size)">
					<WorkflowIcon aria-hidden className="size-[1em] shrink-0 text-muted-foreground" />
					<span className="truncate">{wolf.name}</span>
				</span>
				<span className="block truncate text-xs text-muted-foreground">orchestrator</span>
			</span>
			<WolfBadge wolf={wolf} />
		</div>
	);
}

/** Re-check liveness this often while the tab is visible (/api/wolves only; no SSE event fires on presence change). */
const ROSTER_POLL_MS = 20_000;

export function SessionsSidebar() {
	const { open, toggle, closeList, mobile } = useSidebar();
	const [chats, setChats] = useState<SessionItem[] | null>(null);
	const [roster, setRoster] = useState<WolfStatus[]>([]);
	const rosterRef = useRef(roster);
	rosterRef.current = roster;
	const rosterByName = useMemo(() => new Map(roster.map((w) => [w.name, w] as const)), [roster]);
	const offlineWolves = useMemo(() => new Set(roster.filter((w) => !w.online).map((w) => w.name)), [roster]);
	const [query, setQuery] = useState("");
	const pathname = usePathname();
	const router = useRouter();
	const { openSubagent } = useSubagentModal();
	/** A subagent opens its modal over this page; anything else navigates. */
	const openItem = (c: SessionItem) => {
		closeList();
		return isChildThread(c) ? openSubagent(c.id, c.meta) : router.push(itemHref(c));
	};
	const { open: openSettings } = useSettingsDialog();

	/* New session (owner, 2026-09-13): NO POST — the button opens the
	   sessionless draft view; the session is created only when the first
	   message is sent (and that message becomes its title). Search: a
	   client-side filter over the poll snapshot — no server round trip. */
	const newSession = useCallback(() => {
		closeList();
		router.push("/chat/new"); // redirects to a thread (see app/chat/new)
	}, [router, closeList]);

	/* FUZZY (owner round 8, 2026-10-05): subsequence match ranked by
	 * fuzzyScore — prefix beats word-boundary beats scattered. Empty query
	 * keeps the natural list order (scores are all 0, sort is stable). */
	const ranked = useMemo(() => {
		const q = query.trim();
		const list = chats;
		if (!list) return list;
		if (!q) return list;
		return list
			.map((c) => {
				const scores = [fuzzyScore(q, c.title), c.alias ? fuzzyScore(q, c.alias) : null, c.branch ? fuzzyScore(q, c.branch) : null, c.kind === "home" ? fuzzyScore(q, "orchestrator") : null].filter((x): x is number => x !== null);
				return { c, score: scores.length ? Math.max(...scores) : null };
			})
			.filter((r): r is { c: (typeof list)[number]; score: number } => r.score !== null)
			.sort((a, b) => b.score - a.score)
			.map((r) => r.c);
	}, [chats, query]);
	/* Thread colors: a pick anywhere (this menu, the thread settings menu) is announced on the shared store and patched into
	   the rows; while a PUT is in flight its value wins over a poll that lands meanwhile. The parent lookup is built once per render. */
	const colorTick = useSyncExternalStore((cb) => onThreadColor(() => cb()), threadColorVersion, threadColorVersion);
	useEffect(
		() =>
			onThreadColor((id, color) =>
				setChats((prev) => (prev ? prev.map((x) => (x.id !== id || (x.color ?? null) === color ? x : ((): SessionItem => { const { color: _o, ...rest } = x; return color ? { ...rest, color } : rest; })())) : prev)),
			),
		[],
	);
	const colorIndex = useMemo(() => {
		void colorTick;
		const rows = (chats ?? []).map((x): SessionItem => {
			const p = pendingColor(x.id);
			if (!p) return x;
			const { color: _o, ...rest } = x;
			return p.color ? { ...rest, color: p.color } : rest;
		});
		return threadColorIndex(rows);
	}, [chats, colorTick]);
	/* Live subagents nest under their parent thread (settled ones are hidden); they never sit at the top level.
	   `shown` stays the flat walk order of the rows on screen. */
	const [showArchived, setShowArchived] = useState(false);
	/* Archived = graduated features (their thread is closed). They leave the main list for a collapsed section below it. */
	const layout = useMemo(() => (chats && ranked ? sidebarLayout(chats, ranked, query.trim() !== "") : null), [chats, ranked, query]);
	const groups = layout?.groups ?? null;
	const archived = layout?.archived ?? [];
	const archivedOpen = showArchived || query.trim() !== "";
	// Home is per wolf: a feature is indented only under a Home of its own wolf.
	const homeWolves = useMemo(() => new Set((groups ?? []).filter((g) => g.top.kind === "home").map((g) => rowWolf(g.top))), [groups]);
	const searching = query.trim() !== "";
	const archivedRunning = archived.reduce((n, g) => n + g.kids.filter(isLive).length, 0);
	const flat = (gs: readonly { top: SessionItem; kids: SessionItem[] }[]) => gs.flatMap((g) => [g.top, ...g.kids]);
	const shown = useMemo(() => (groups ? [...flat(groups), ...(archivedOpen ? flat(archived) : [])] : null), [groups, archived, archivedOpen]);

	const renderGroup = (g: { top: SessionItem; kids: SessionItem[] }, indented: boolean) => {
							const row = (c: SessionItem, nested: boolean, indented = false) => {
								const at = shown!.indexOf(c);
								return renamingId === c.id ? (
									<RenameRow
										key={c.id}
										chat={c}
										onCommit={(next) => void commitRename(c.id, next)}
										onCancel={() => setRenamingId(null)}
									/>
								) : (
									<SessionRow
										key={c.id}
										chat={c}
										dotColor={c.href ? threadColor(colorIndex.get(c.id) ?? c, colorIndex).hex : undefined}
										nested={nested}
										indented={indented}
										offline={offlineWolves.has(rowWolf(c))}
										wolfStatus={rosterByName.get(rowWolf(c))}
										active={pathname === itemHref(c)}
										kbdSelected={at === kbdIndex}
										onOpen={() => {
											setKbdIndex(null);
											openItem(c);
										}}
										// Thread rows: a color-only menu (rename/delete/export are legacy chat-record actions).
										onContextMenu={(e) => openContext(e, c)}
									/>
								);
							};
		return [row(g.top, false, indented), ...g.kids.map((k) => row(k, true))];
	};

	const refresh = useMemo(() => coalescedRefresh(async () => {
		// In-flight coalesce (S6): event bursts may land several refresh
		// calls at once. A call during a fetch marks it dirty and ONE more
		// fetch follows, so the final event of a burst is never lost.
		try {
			// The list is the ConsoleClient's: every wolf's threads.
			const wolvesRes = await fetch("/api/wolves", { cache: "no-store" });
			// 401 = auth lost, not offline: the fetch wrapper sends the browser to /pair; leave the list as it is.
			if (wolvesRes.status === 401) return;
			if (!wolvesRes.ok) throw new Error(`roster ${wolvesRes.status}`);
			const wolves = (await wolvesRes.json()) as {
				wolves: { name: string; status?: string }[];
			};
			if (!Array.isArray(wolves.wolves)) throw new Error("bad roster");
			const results = await Promise.all(
				wolves.wolves.map(async (w) => {
					try {
						const res = await fetch(`/api/wolves/${encodeURIComponent(w.name)}/threads`, { cache: "no-store" });
						const d = (await res.json()) as { threads?: { id: string; title: string; status?: "idle" | "busy" | "needs-you"; closed?: boolean; kind?: string; workspace?: { branch?: string }; settings?: { color?: string } }[] };
						return { wolf: w.name, threads: res.ok && Array.isArray(d.threads) ? d.threads : undefined };
					} catch {
						return { wolf: w.name, threads: undefined }; // this wolf keeps its last rows; the others still update
					}
				}),
			);
			setChats((prev) => foldWolfThreads(prev, results));
			setRoster((prev) => foldWolfRoster(prev, wolves.wolves));
		} catch {
			// a transient failure keeps the last snapshot; the server is unreachable, so every known wolf reads offline
			setRoster((prev) => foldWolfRoster(prev, undefined));
			setChats((prev) => prev ?? []);
		}
	}), []);

	/* Instant rename propagation (2026-09-17): the chat header's rename
	   commits dispatch wolfpack:chat-renamed; patch the snapshot in place instead
	   of waiting for the 2.5s poll. */
	useEffect(() => {
		const onRenamed = (e: Event) => {
			const { id, title } = (e as CustomEvent<{ id: string; title: string }>).detail;
			setChats((prev) => (prev ? prev.map((c) => (c.id === id ? { ...c, title } : c)) : prev));
		};
		window.addEventListener("wolfpack:chat-renamed", onRenamed);
		return () => window.removeEventListener("wolfpack:chat-renamed", onRenamed);
	}, []);

	/* INSTANT TURN-STATE (owner, sidebar round 2026-10-02): the open
	   session broadcasts wolfpack:turn-state the instant its turn starts
	   (submitted — the optimistic machine's own flip) and at settle —
	   busy mirrors the server's own definition (isTurnRunning), so the
	   patch is exact: spinner up the moment the action happens, cleared
	   and refetched once at settle (title/order move with turns). The
	   events channel is the backstop for everything only the server
	   knows: other windows, wake turns in unopened sessions. A start on
	   a chat not yet in the snapshot (a brand-new session) = one
	   immediate refresh instead of a patch. */
	const chatsRef = useRef(chats);
	chatsRef.current = chats;
	useEffect(() => {
		const onTurnState = (e: Event) => {
			const { id, running } = (e as CustomEvent<{ id: string; running: boolean }>).detail;
			if (running) {
				if (chatsRef.current?.some((c) => c.id === id)) {
					setChats((prev) => (prev ? prev.map((c) => (c.id === id ? { ...c, busy: true } : c)) : prev));
				} else {
					void refresh(); // the brand-new session: it isn't in the snapshot yet
				}
				return;
			}
			setChats((prev) => (prev ? prev.map((c) => (c.id === id ? { ...c, busy: false } : c)) : prev));
			void refresh(); // settle: the server snapshot is now truthful — land it now
		};
		window.addEventListener("wolfpack:turn-state", onTurnState);
		return () => window.removeEventListener("wolfpack:turn-state", onTurnState);
	}, [refresh]);

	/* PUSH (architecture S6, 2026-10-02): the 2.5s poll is RETIRED — the
	   last standing network poll in the app. List truth arrives as
	   events: chats-changed (create/rename/delete — the list-SHAPE
	   writes), and turn-started/turn-settled for EVERY chat (unfiltered:
	   any chat's turn flips busy/order/phase in this list). Announced
	   fetches ride the 250ms trailing debounce (the S4/S5 law); resync
	   (reconnect / dev-restart) is immediate. wolfpack:turn-state +
	   wolfpack:chat-renamed stay for same-tab INSTANTS — local beats any
	   round-trip. */
	const refreshRef = useRef(refresh);
	refreshRef.current = refresh;
	/* Events keep coming while subagents work: a throttle, not a debounce (a debounce would never fire under a steady
	   stream). The first event refreshes at once, then at most one refresh per second, the last event always landing. */
	const lastRefreshRef = useRef(0);
	const eventDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const scheduleEventRefresh = () => {
		if (eventDebounceRef.current) return; // a trailing refresh is already due
		const wait = Math.max(0, lastRefreshRef.current + 1000 - Date.now());
		eventDebounceRef.current = setTimeout(() => {
			eventDebounceRef.current = undefined;
			lastRefreshRef.current = Date.now();
			void refreshRef.current();
		}, wait);
	};
	useServerEvent("chats-changed", scheduleEventRefresh);
	useServerEvent("turn-started", scheduleEventRefresh);
	useServerEvent("turn-settled", scheduleEventRefresh);
	useServerEvent("compaction-changed", scheduleEventRefresh);
	useServerEvent("needs-you-changed", scheduleEventRefresh);
	useServerEvent("thread-updated", scheduleEventRefresh);
	useServerResync(() => void refreshRef.current());
	/* Presence changes fire no event, so re-check liveness on a timer (paused while the tab is hidden). The tick is ONE
	   /api/wolves call; threads are fetched only for a wolf that just came back online (the SSE/resync paths cover the rest). */
	useEffect(() => {
		const tick = async () => {
			const { roster: next, recovered } = await checkRoster((u, i) => fetch(u, i), rosterRef.current);
			setRoster(next);
			if (recovered.length === 0) return;
			const got = await Promise.all(
				recovered.map(async (wolf) => {
					try {
						const res = await fetch(`/api/wolves/${encodeURIComponent(wolf)}/threads`, { cache: "no-store" });
						const d = (await res.json()) as { threads?: Parameters<typeof foldWolfThreads>[1][number]["threads"] };
						return { wolf, threads: res.ok && Array.isArray(d.threads) ? d.threads : undefined };
					} catch {
						return { wolf, threads: undefined }; // keeps its stale rows; the roster status is untouched
					}
				}),
			);
			setChats((prev) => foldWolfThreads(prev, next.map((w) => got.find((g) => g.wolf === w.name) ?? { wolf: w.name, threads: undefined })));
		};
		return startVisibleTimer(() => void tick(), ROSTER_POLL_MS, document);
	}, []);

	/* ── Keyboard seams (shortcut wave A, 2026-09-17; search-walk round
	   2026-10-10) ── ⌘⇧F focuses the search field — and THE SEARCH OWNS THE
	   WALK: ↑/↓ cycle the filtered list (wrap — "cycle"), Enter opens the
	   walked row, or the FIRST match when nothing is walked (owner,
	   2026-10-10 — the quick-open pattern: ⌘⇧F, type, Enter, done). The
	   Alt+↑/↓/↵ global cycle was RETIRED the same round: barely used,
	   felt laggy. The selection is a row index into `shown`, so the walk
	   follows whatever the query + kind filter leave. Mouse and keyboard
	   coexist: hovering doesn't claim, a click or an open clears the
	   selection. */
	const [kbdIndex, setKbdIndex] = useState<number | null>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	/* ── Wave 6 chunk A: context menu + inline rename + deletion ──
	   Right-click a session row → MenuShell: the two management actions
	   first (owner ruling), then — below a hairline — the extraction
	   coverage block (owner-locked redesign 2026-09-24, order refined
	   2026-09-24: Rename/Delete on top, the numbers + manual Extract
	   affordance at the bottom). The anchor is the row that was
	   right-clicked — assigned into a ref before the state flip so the
	   shell measures it on its first (hidden) pass. */
	const [ctxChatId, setCtxChatId] = useState<string | null>(null);
	const ctxAnchorRef = useRef<HTMLElement | null>(null);
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<ChatListItem | null>(null);

	/** Captured when the menu opens: a thread row gets the color menu, anything else the legacy session menu. */
	const [ctxIsThread, setCtxIsThread] = useState(false);
	const ctxThread = ctxChatId !== null && ctxIsThread ? chats?.find((c) => c.id === ctxChatId) : undefined;
	// A thread row that vanished (poll) closes its menu; it never falls through to rename/delete.
	useEffect(() => {
		if (ctxChatId !== null && ctxIsThread && ctxThread === undefined) setCtxChatId(null);
	}, [ctxChatId, ctxIsThread, ctxThread]);
	/** Save the override through the thread settings route. The shared store announces it, holds it over polls, and only the latest call may roll back. */
	const setThreadColorOf = async (c: SessionItem, color: string | null) => {
		const seq = beginColorChange(c.id, color, c.color ?? null);
		let ok = false;
		try {
			const wolf = rowWolf(c);
			const res = await fetch(settingsUrl(wolf, threadSlug(wolf, c.id)), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ color }) });
			if (!res.ok) throw new Error(`color ${res.status}`);
			ok = true;
		} catch (err) {
			console.error("thread color failed:", err);
		}
		settleColorChange(c.id, seq, ok);
	};

	const openContext = (e: React.MouseEvent<HTMLButtonElement>, chat: ChatListItem) => {
		e.preventDefault(); // suppress the native menu
		ctxAnchorRef.current = e.currentTarget;
		setCtxIsThread(Boolean((chat as SessionItem).href));
		setCtxChatId(chat.id);
	};

	// The menu contract (agent-section's): any pointerdown outside the menu
	// or its row closes it; Esc is CLAIMED so it never also aborts a turn
	// or folds the sidebar. Right-clicking another row re-anchors: its
	// pointerdown closes this menu, its contextmenu opens the next.
	useEffect(() => {
		if (ctxChatId === null) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (target instanceof Element && target.closest("[data-wp-menu]")) return;
			if (ctxAnchorRef.current?.contains(target)) return;
			setCtxChatId(null);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setCtxChatId(null);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [ctxChatId]);

	// Inline rename (owner ruling, wave 6): the row swaps to a text input;
	// commit rides the SAME plumbing as the header rename — PUT the title,
	// then wolfpack:chat-renamed patches every listener (this sidebar's own
	// listener patches the snapshot instantly; an open chat header hears
	// it too). Esc discards; empty commit discards (the header's rules).
	const commitRename = useCallback(async (id: string, next: string) => {
		setRenamingId(null);
		const t = next.trim();
		if (t === "") return;
		try {
			const res = await fetch(`/api/chats/${id}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: t }),
			});
			if (!res.ok) throw new Error(`rename failed: ${res.status}`);
			window.dispatchEvent(new CustomEvent("wolfpack:chat-renamed", { detail: { id, title: t } }));
		} catch (err) {
			console.error("rename failed:", err); // keep the old title
		}
	}, []);

	// Delete success: patch the list instantly (the poll is the backstop),
	// navigate home if the open session died (the chat view unmounts —
	// drafts die with it, no orphan bubbles).
	const onDeleted = useCallback(
		(id: string) => {
			setDeleting(null);
			setChats((prev) => (prev ? prev.filter((c) => c.id !== id) : prev));
			if (pathname === `/chat/${id}`) router.push("/");
		},
		[pathname, router],
	);

	useEffect(() => {
		const onFocusSearch = () => {
			if (!open) toggle();
			// A clipped (overflow-hidden) input still focuses — the sidebar's
			// slide-in doesn't gate the keystroke.
			requestAnimationFrame(() => searchRef.current?.focus());
		};
		window.addEventListener("wolfpack:kbd-sessions-search", onFocusSearch);
		return () => window.removeEventListener("wolfpack:kbd-sessions-search", onFocusSearch);
	}, [open, toggle]);

	// Keep the kbd-selected row in view (the rows are the container's only
	// buttons, so the index matches).
	useEffect(() => {
		if (kbdIndex === null) return;
		listRef.current?.querySelectorAll('[data-testid^="session-row"]')[kbdIndex]?.scrollIntoView({ block: "nearest" });
	}, [kbdIndex]);

	useEffect(() => {
		if (!open) return;
		void refresh();
		// Opening + navigation refetch; while open, the events channel owns
		// freshness (S6) — no interval, nothing standing.
	}, [open, pathname, refresh]);

	return (
		<aside
			// < md: the open sidebar is the full-screen list layer (fixed, above everything but dialogs); md+ is the original inline panel.
			className={cn("sidebar-motion shrink-0 overflow-hidden duration-200", open ? "max-md:fixed max-md:inset-0 max-md:z-[60] max-md:w-full md:w-72" : "w-0")}
			aria-hidden={!open}
			data-testid="sidebar"
			data-mobile-list={(open && mobile) || undefined}
		>
			<div className="flex h-full w-72 flex-col border-r bg-background max-md:w-full max-md:pt-[env(safe-area-inset-top)] max-md:pb-[env(safe-area-inset-bottom)]">
				{/* LH wordmark — the owner's header; close toggle sits at the edge.
				    Merged chrome (2026-09-17): in Electron this band is the
				    window's drag surface and starts after the traffic lights
				    (.wp-lights-gutter); in the browser those classes are inert. */}
				<div className="wp-drag wp-lights-gutter flex items-center justify-between px-4 py-3">
					{/* The owner's mark (2026-09-17) replaces the "LH" text — still the
					    home link, still vertically centered by the band's items-center.
					    The 92px .wp-lights-gutter keeps it clear of the traffic lights
					    with the lights' own edge-inset as the gap. */}
					{/* Hover mirrors the ghost toggle buttons (owner ask, 2026-09-17):
					    same size-9 chip geometry, same hover:bg-accent treatment. */}
					<Hint
						// Kept (owner, subtlety round 2026-09-25) but to the RIGHT
						// of the logo, carrying its real shortcut: ⌘G jumps to
						// the graph view (keyboard-shortcuts routes it to "/",
						// the same destination as this logo).
						label="Home"
						action="jump-graph"
						side="right"
					>
						<Link
							href="/"
							onClick={closeList}
							aria-label="Home"
							className="wp-no-drag flex size-9 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50"
						>
							<WolfpackMark className="size-6" />
						</Link>
					</Hint>
					<Hint label="Close sidebar" action="toggle-sidebar">
						<Button
							variant="ghost"
							size="icon"
							aria-label="Close sidebar"
							onClick={toggle}
							className="wp-no-drag"
						>
							<PanelLeftCloseIcon className="size-4" />
						</Button>
					</Hint>
				</div>

				<div className="mx-3 mb-2 flex flex-col gap-1.5">
					<button
						type="button"
						data-testid="new-session"
						onClick={() => void newSession()}
						className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<PlusIcon className="size-3" />
						New session
					</button>
					<Link
						href="/"
						onClick={closeList}
						data-testid="nav-graph"
						aria-current={pathname === "/" ? "page" : undefined}
						className={cn(
							"flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider transition-colors hover:bg-accent hover:text-foreground",
							pathname === "/" ? "bg-accent text-foreground" : "text-muted-foreground",
						)}
					>
						<NetworkIcon className="size-3" />
						Graph
					</Link>
					<Link
						href="/kb-activity"
						onClick={closeList}
						data-testid="nav-kb-activity"
						aria-current={pathname === "/kb-activity" ? "page" : undefined}
						className={cn(
							"flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider transition-colors hover:bg-accent hover:text-foreground",
							pathname === "/kb-activity" ? "bg-accent text-foreground" : "text-muted-foreground",
						)}
					>
						<WorkflowIcon className="size-3" />
						KB activity
					</Link>
					<Link
						href="/prompts"
						onClick={closeList}
						data-testid="nav-prompts"
						aria-current={pathname === "/prompts" ? "page" : undefined}
						className={cn(
							"flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider transition-colors hover:bg-accent hover:text-foreground",
							pathname === "/prompts" ? "bg-accent text-foreground" : "text-muted-foreground",
						)}
					>
						<FileTextIcon className="size-3" />
						Prompts
					</Link>
					<WorkNavEntry />
				</div>

				{/* Headless: raises OS/browser notifications for newly waiting cards. The rows carry the visible needs-you mark. */}
				<NeedsYouNotifier />

				<div className="mx-3 mb-2 flex items-center gap-2">
					<span className="text-xs uppercase tracking-widest text-muted-foreground/70">Sessions</span>
					<Hint label="Search sessions" action="sessions-search" side="bottom">
					<span className="relative flex-1">
						<Input
							ref={searchRef}
							data-testid="session-search"
							value={query}
							onChange={(e) => {
								setQuery(e.target.value);
								// The list reorders under the query every keystroke —
								// a stale walk index would point at the wrong row.
								setKbdIndex(null);
							}}
							// THE SEARCH OWNS THE WALK (owner, 2026-10-10 — the
							// retired Alt+↑/↓/↵ cycle's successor): ↑/↓ cycle the
							// filtered rows (wrap), Enter opens the walked row —
							// or the FIRST match when nothing is walked (the
							// quick-open pattern) — then blurs (focus returns to
							// the app per the Enter law; the query stays for
							// re-searching). Esc leaves the search (owner,
							// keyboard wave): blur back to normal, and claim the
							// key so the window Esc chain (dictation / abort)
							// doesn't also fire.
							onKeyDown={(e) => {
								if (e.key === "Escape") {
									e.stopPropagation();
									e.currentTarget.blur();
									return;
								}
								// Modified keys belong to the surface (⇧↵ etc.).
								if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
								const n = shown?.length ?? 0;
								if (n === 0) return;
								if (e.key === "ArrowDown" || e.key === "ArrowUp") {
									// The rows move, not the caret.
									e.preventDefault();
									const dir = e.key === "ArrowDown" ? 1 : -1;
									setKbdIndex((i) =>
										i === null || i >= n ? (dir === 1 ? 0 : n - 1) : (i + dir + n) % n,
										);
									return;
								}
								if (e.key === "Enter") {
									const target = shown![kbdIndex !== null && kbdIndex < n ? kbdIndex : 0];
									if (!target) return;
									e.preventDefault();
									openItem(target);
									setKbdIndex(null);
									e.currentTarget.blur();
								}
							}}
							placeholder="Search…"
							aria-label="Search sessions"
							className="h-6 rounded-sm border-border bg-background pl-6 text-xs placeholder:text-muted-foreground/60"
						/>
						<SearchIcon className="pointer-events-none absolute left-1.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground/70" />
					</span>
					</Hint>
				</div>

				<div ref={listRef} className="flex-1 overflow-y-auto p-2">
					{shown === null ? (
						<div className="px-2 py-4 text-xs text-muted-foreground">Loading…</div>
					) : shown.length === 0 && archived.length === 0 && (searching || roster.length === 0) ? (
						<div className="px-2 py-4 text-xs text-muted-foreground">
							{query.trim() ? "No sessions match." : "No sessions yet."}
						</div>
					) : (
						[
							...groups!.flatMap((g) => renderGroup(g, g.top.kind !== "home" && homeWolves.has(rowWolf(g.top)))),
							...(searching ? [] : roster.filter((w) => !homeWolves.has(w.name)).map((w) => <WolfHeaderRow key={`wolf-header-${w.name}`} wolf={w} />)),
						]
					)}
					{archived.length > 0 && (
						<>
							<button
								type="button"
								data-testid="archived-toggle"
								aria-expanded={archivedOpen}
								// A search forces the section open, so the toggle is inert (and drops its chevron) meanwhile.
								disabled={searching}
								onClick={() => setShowArchived((v) => !v)}
								className="mt-2 flex w-full items-center gap-1 rounded-lg px-3 py-1 text-left text-xs uppercase tracking-widest text-muted-foreground/70 hover:bg-accent disabled:pointer-events-none"
							>
								{searching ? <span className="size-3" /> : archivedOpen ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
								Archived ({archived.length})
								{archivedRunning > 0 && !archivedOpen && (
									<span data-testid="archived-running" className="ml-1 flex items-center gap-1 normal-case tracking-normal text-foreground">
										· <BrailleSpinner className="h-[1.25em]" label="running" /> {archivedRunning} running
									</span>
								)}
							</button>
							{archivedOpen && archived.flatMap((g) => renderGroup(g, true))}
						</>
					)}
				</div>

					{/* Background agents (owner, sidebar round): the section is
					    ALWAYS here — empty means empty (the header sits alone); it
					    populates and grows when processes run. The session list is
					    flex-1, so this pins to the bottom. Sidebar closed = the
					    learner opted out (no ambient signal, user decision). */}
					{/* The legacy session-job feed: only drawn while a non-wolfd job runs. */}
					<ActivitySection hideWhenEmpty />

					{/* Settings entry (settings-app wave): same row language as
					    New session — quiet, bottom-pinned, opens the centered
					    dialog (also mod+, in the keyboard registry). */}
					<div className="px-3 pb-3 pt-1">
						<NotifyToggle />
						<Hint label="Settings" action="open-settings" side="right">
							<button
								type="button"
								onClick={() => {
									closeList(); // the dialog must not open behind the full-screen list
									openSettings();
								}}
								data-testid="settings-entry"
								className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
							>
								<SettingsIcon className="size-3" />
								Settings
							</button>
						</Hint>
					</div>
				</div>

				{/* The context menu (wave 6): the management actions. MenuShell
				    owns placement/focus/arrow cycling; the dismissal effect above
				    owns the contract. */}
				{ctxChatId !== null && ctxThread !== undefined && (
					<MenuShell
						anchorRef={ctxAnchorRef}
						testid="thread-context-menu"
						preferredSide="down"
						menuClass="flex w-56 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl"
					>
						<div className="px-2 text-muted-foreground">Thread color</div>
						{isChildThread(ctxThread) ? (
							<div className="px-2 py-1.5 text-muted-foreground">A subagent uses its parent's color.</div>
						) : (
							<ThreadColorPicker
								value={colorIndex.get(ctxThread.id)?.color ?? undefined}
								autoHex={THREAD_COLORS[autoThreadColor(ctxThread.id)]}
								onPick={(color) => {
									setCtxChatId(null);
									void setThreadColorOf(ctxThread, color);
								}}
							/>
						)}
					</MenuShell>
				)}
				{ctxChatId !== null && !ctxIsThread && (
					<MenuShell
						anchorRef={ctxAnchorRef}
						testid="session-context-menu"
						preferredSide="down"
						menuClass="flex w-52 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl"
					>
						<button
							type="button"
							data-testid="ctx-rename"
							onClick={() => {
								setRenamingId(ctxChatId);
								setCtxChatId(null);
							}}
							className="flex items-center rounded-lg px-2.5 py-1.5 text-left text-foreground transition-colors hover:bg-accent"
						>
							Rename
						</button>
						{/* Export as Markdown (owner, release polish 2026-10-06): the
					    session-markdown engine's user-facing debut — same-origin
						    anchor download; the route's Content-Disposition names the
						    file. Sits with the management actions, above Delete (the
						    destructive action stays last — the danger-fence law). */}
						<button
							type="button"
							data-testid="ctx-export-md"
							onClick={() => {
								const chatId = ctxChatId;
								setCtxChatId(null);
								const a = document.createElement("a");
								a.href = `/api/chats/${chatId}/markdown`;
								a.download = ""; // the route's filename wins
								document.body.appendChild(a);
								a.click();
								a.remove();
							}}
							className="flex items-center rounded-lg px-2.5 py-1.5 text-left text-foreground transition-colors hover:bg-accent"
						>
							Export as Markdown…
						</button>
						<button
							type="button"
							data-testid="ctx-delete"
							onClick={() => {
								const target = chats?.find((c) => c.id === ctxChatId);
								if (target) setDeleting(target);
								setCtxChatId(null);
							}}
							className="flex items-center rounded-lg px-2.5 py-1.5 text-left text-muted-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
						>
							Delete…
						</button>
					</MenuShell>
				)}

				{/* The delete dialog (wave 6) — portaled to body
				    by the component itself, lives here for state locality. */}
				<DeleteSessionDialog
					chat={deleting}
					onClose={() => setDeleting(null)}
					onDeleted={onDeleted}
				/>
			</aside>
	);
}

/** The app frame: sidebar inline + content. Rendered once in the root layout. */
export function AppShell({ children }: { children: React.ReactNode }) {
	return (
		<SettingsDialogProvider>
			<SessionsSidebar />
			<main className="min-w-0 flex-1">{children}</main>
			{/* The floating chat bar: one per window, on every route (draws nothing without its provider). */}
			<ChatBar />
			{/* The one work reader: `?item=<id>` opens it over whichever page this is. */}
			<WorkReaderHost />
			{/* The single document-level keydown listener (keyboard wave A) —
			    after the content in the tree, but it's window-level so order only
			    matters for the events it dispatches, never for DOM priority. */}
			<KeyboardShortcuts />
			<CommandPalette />
		</SettingsDialogProvider>
	);
}
