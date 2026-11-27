"use client";

/**
 * The context tree (work-wolfpack-ftBY9Qv): the owner's context switcher, INSIDE the chat bar. Opened by a wolf's den button or the bar header's wolf
 * name, it is the top section of the bar's own card (same border, same width): the height animates open (reduced motion: instantly), capped at about
 * 50vh, scrolling inside. It replaces both the old Switcher popover and the den popover sheet, there is no floating element.
 *
 * Hierarchy: the wolf (its mark in its colour, name, online dot) > its threads (a House for the home thread, the Work list icon for feature threads;
 * a count badge for the cards waiting in it; the attached thread highlighted) > the waiting cards (card icon, headline, Answer).
 * A thread row attaches the chat to it and collapses the tree; its eye and open-page icon buttons (hover or focus, always on the phone) open that
 * thread's visualizations or its page. The model is `buildDenSheet` in src/core/thread/den-strip.ts.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { EyeIcon, HouseIcon, ListTreeIcon, MessageCircleQuestionIcon, MessageSquareIcon } from "lucide-react";
import { useAttachedThread } from "@/components/chat-bar/attached-thread";
import { BrailleSpinner } from "@/components/shell/braille-spinner";
import { WolfpackMark } from "@/components/shell/wolfpack-mark";
import { Hint } from "@/components/ui/hint";
import { useFrameBadges } from "@/components/viewer/frame-store";
import { cn } from "@/lib/utils";
import { buildDenSheet, buildDenStrip, inFrozenOrder, switcherOrder, type DenRow, type DenSheetThread, type NeedsYouItem } from "@/src/core";

interface Props {
	wolf: string;
	/** The pending cards (the strip fetches them). */
	items: NeedsYouItem[];
	phone?: boolean;
	onClose: () => void;
	/** Leave for a thread's page (waits for a running dictation first); `viz` turns its visualization mode on. */
	onLeave: (wolf: string, threadId: string, viz: boolean) => void;
}

const reveal = "grid transition-[grid-template-rows] duration-200 motion-reduce:transition-none";

export function ContextTree({ wolf, items, phone = false, onClose, onLeave }: Props) {
	const api = useAttachedThread()!;
	const router = useRouter();
	const ref = useRef<HTMLDivElement | null>(null);
	const [shown, setShown] = useState(false);
	useEffect(() => {
		const id = requestAnimationFrame(() => setShown(true));
		return () => cancelAnimationFrame(id);
	}, []);
	// The order is frozen while the tree is open (nothing jumps under the pointer); statuses and counts stay live, the next open re-sorts.
	const [frozen] = useState(() => switcherOrder(api.groups));
	const groups = useMemo(() => inFrozenOrder(api.groups, frozen), [api.groups, frozen]);
	const strip = useMemo(() => buildDenStrip(api.wolves, api.threads, items, null, wolf), [api.wolves, api.threads, items, wolf]);
	const item = strip.find((s) => s.wolf === wolf) ?? null;
	const sheet = item ? buildDenSheet(item, groups.find((g) => g.wolf === wolf), api.attached) : null;

	useEffect(() => {
		const key = (e: KeyboardEvent) => void (e.key === "Escape" && !e.defaultPrevented && onClose());
		const down = (e: Event) => {
			const t = e.target as Element | null;
			if (!t || ref.current?.contains(t)) return;
			// The strip's wolf buttons and the bar header's wolf name toggle the tree themselves.
			if (t.closest?.('[data-testid="chat-bar-chip"], [data-testid="den-wolf"], [data-testid="chat-bar-swap"]')) return;
			onClose();
		};
		document.addEventListener("keydown", key);
		document.addEventListener("pointerdown", down);
		return () => {
			document.removeEventListener("keydown", key);
			document.removeEventListener("pointerdown", down);
		};
	}, [onClose]);
	useEffect(() => {
		ref.current?.querySelector<HTMLElement>('[aria-current="true"]')?.focus({ preventScroll: true });
	}, []);
	if (!sheet) return null;

	const attach = (threadId: string) => {
		api.attach({ wolf, threadId });
		onClose();
	};
	/** Whether the thread that raised the card can hold the chat (home / feature, not a subagent). */
	const attachableRow = (row: DenRow) => {
		const t = api.threads[row.wolf]?.find((x) => x.id === row.threadId);
		return !!t && (t.kind === "home" || t.kind === "feature") && !t.parentThreadId;
	};
	const answer = (row: DenRow) => {
		if (attachableRow(row)) attach(row.threadId);
		else {
			onClose();
			router.push(row.href);
		}
	};
	const card = (row: DenRow, title?: boolean) => (
		<div key={`${row.threadId}:${row.callId}`} data-testid="den-row" className="flex items-center gap-1.5 py-0.5 pl-2">
			<MessageCircleQuestionIcon aria-hidden className="size-3.5 shrink-0 text-amber-500" />
			<a
				href={row.href}
				onClick={(e) => {
					e.preventDefault();
					// Opening a card's page also swaps the chat to the thread that raised it.
					if (attachableRow(row)) api.attach({ wolf: row.wolf, threadId: row.threadId });
					onClose();
					router.push(row.href);
				}}
				className="flex min-w-0 flex-1 flex-col rounded-md px-1 py-0.5 hover:bg-accent max-md:min-h-11 max-md:justify-center"
			>
				{title && <span className="truncate font-ui text-xs font-medium">{row.title}</span>}
				<span className="line-clamp-2 font-ui text-xs text-muted-foreground">{row.summary}</span>
			</a>
			<button type="button" aria-label={`Answer ${row.title}`} onClick={() => answer(row)} className="shrink-0 rounded-md px-2 py-1 font-ui text-xs text-amber-600 hover:bg-accent max-md:min-h-11 dark:text-amber-400">
				Answer
			</button>
		</div>
	);
	const guide = "ml-2 border-l border-border pl-4"; // 16px of indent per level
	return (
		<div className={cn(reveal, shown ? "grid-rows-[1fr]" : "grid-rows-[0fr]", phone && "min-h-0")} data-testid="den-sheet-reveal">
			<div
				ref={ref}
				role="dialog"
				aria-label={`${wolf}: switch thread`}
				data-testid="den-sheet"
				data-layout="inline"
				onKeyDown={(e) => {
					if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
					e.preventDefault();
					const list = Array.from(ref.current?.querySelectorAll<HTMLElement>('[data-testid="den-thread"]') ?? []);
					const i = list.indexOf(document.activeElement as HTMLElement);
					list[(i + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?.focus();
				}}
				className="max-h-[50dvh] min-h-0 overflow-y-auto overflow-x-hidden border-b px-1.5 py-1.5 outline-none"
			>
				<div className="flex items-center gap-1.5 px-1 py-0.5 font-ui text-sm" style={{ color: sheet.color }}>
					<WolfpackMark className="size-4 shrink-0" />
					<b className="min-w-0 truncate">{wolf}</b>
					<span role="img" aria-label={sheet.online ? "online" : "offline"} data-testid="den-sheet-dot" className={cn("size-1.5 shrink-0 rounded-full", sheet.online ? "bg-emerald-500" : "bg-muted-foreground/40")} />
					{sheet.needsYou > 0 && <span data-testid="den-sheet-count" aria-label={`${sheet.needsYou} waiting for you`} className="rounded-full bg-amber-500/15 px-1.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">{sheet.needsYou}</span>}
				</div>
				<div className={guide}>
					{sheet.threads.length === 0 && sheet.other.length === 0 && <p className="py-1 text-xs text-muted-foreground">No threads yet.</p>}
					{sheet.threads.map((t) => (
						<ThreadNode key={t.threadId} wolf={wolf} t={t} onAttach={() => attach(t.threadId)} onLeave={(viz) => onLeave(wolf, t.threadId, viz)}>
							{t.rows.length > 0 && <div className={guide}>{t.rows.map((r) => card(r))}</div>}
						</ThreadNode>
					))}
					{sheet.other.length > 0 && <div data-testid="den-other">{sheet.other.map((r) => card(r, true))}</div>}
				</div>
			</div>
		</div>
	);
}

/** One thread: icon, title, count, and the row's own icon buttons (eye with its count, open the page); its cards nest under it. */
function ThreadNode({ wolf, t, onAttach, onLeave, children }: { wolf: string; t: DenSheetThread; onAttach: () => void; onLeave: (viz: boolean) => void; children?: React.ReactNode }) {
	const frames = useFrameBadges(wolf, t.threadId);
	const Icon = t.kind === "home" ? HouseIcon : ListTreeIcon;
	const iconBtn = "flex shrink-0 items-center justify-center gap-0.5 rounded-md p-1 text-muted-foreground hover:bg-accent focus-visible:opacity-100 disabled:opacity-40 max-md:min-h-11 max-md:min-w-11 md:opacity-0 md:group-hover/row:opacity-100 md:disabled:group-hover/row:opacity-40";
	return (
		<div data-testid="den-thread-group">
			<div className={cn("group/row flex items-center rounded-md hover:bg-accent/60", t.current && "bg-accent")}>
				<button
					type="button"
					data-testid="den-thread"
					data-thread={t.threadId}
					data-status={t.status}
					data-needs-you={t.needsYou > 0 ? t.needsYou : undefined}
					aria-current={t.current ? "true" : undefined}
					onClick={onAttach}
					className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm focus-visible:bg-accent focus-visible:outline-none max-md:min-h-11"
				>
					<Icon aria-hidden data-testid="den-thread-icon" data-kind={t.kind} className="size-4 shrink-0 text-muted-foreground" />
					<span className="min-w-0 flex-1 truncate">{t.title}</span>
					{t.needsYou > 0 ? (
						<span data-testid="den-thread-count" aria-label={`${t.needsYou} waiting for you`} className="rounded-full bg-amber-500/15 px-1.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">{t.needsYou}</span>
					) : (
						t.status === "busy" && <BrailleSpinner />
					)}
				</button>
				<Hint label="Visualizations">
					<button type="button" data-testid="den-thread-viz" aria-label={`Open visualizations of ${t.title}`} disabled={frames.length === 0} onClick={() => onLeave(true)} className={iconBtn}>
						<EyeIcon aria-hidden className="size-4" />
						{frames.length > 0 && <span className="font-ui text-[10px]">{frames.length}</span>}
					</button>
				</Hint>
				<Hint label="Open thread page">
					<button type="button" data-testid="den-thread-open" aria-label={`Open ${t.title} page`} onClick={() => onLeave(false)} className={iconBtn}>
						<MessageSquareIcon aria-hidden className="size-4" />
					</button>
				</Hint>
			</div>
			{children}
		</div>
	);
}
