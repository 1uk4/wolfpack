"use client";

/**
 * The den strip (work-wolfpack-XR2Jmxf): a row of wolf buttons on top of the chat bar, floating or docked. Each button is the wolf's colour,
 * wears a red badge with the cards waiting on the owner and a pulsing dot while the wolf works. A click opens a sheet above the strip listing
 * what that wolf waits on (thread title and the card's headline); a row opens its thread, its Answer button attaches the bar to the thread
 * so the card is answered in the bar's own card flow. Esc, a second click or a click outside closes it. The model is src/core/thread/den-strip.ts.
 * The strip sits inside the bar's box, so `--chat-bar-top` (the bar's top) counts it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MessageCircleQuestionIcon, PawPrintIcon } from "lucide-react";
import { useAttachedThread } from "@/components/chat-bar/attached-thread";
import { useOptionalServerEvent } from "@/components/shell/server-events";
import { Hint } from "@/components/ui/hint";
import { cn } from "@/lib/utils";
import { ZC } from "@/lib/z-layers";
import { buildDenStrip, denLabel, type DenRow, type NeedsYouItem } from "@/src/core";

/** The pending cards from /api/needs-you, fetched while the sheet is open and refetched on every needs-you-changed (no polling). */
function useNeedsYouItems(enabled: boolean): NeedsYouItem[] {
	const [items, setItems] = useState<NeedsYouItem[]>([]);
	const seq = useRef(0);
	const load = useCallback(() => {
		if (!enabled) return;
		const n = ++seq.current;
		void (async () => {
			try {
				const res = await fetch("/api/needs-you", { cache: "no-store" });
				if (!res.ok || n !== seq.current) return;
				const body = (await res.json()) as { items?: NeedsYouItem[] };
				if (n === seq.current && Array.isArray(body.items)) setItems(body.items);
			} catch {
				/* keep the last list */
			}
		})();
	}, [enabled]);
	useEffect(() => load(), [load]);
	useOptionalServerEvent("needs-you-changed", load);
	return items;
}

export function DenStrip({ phone = false }: { phone?: boolean }) {
	const api = useAttachedThread()!;
	const router = useRouter();
	const [open, setOpen] = useState<string | null>(null);
	const boxRef = useRef<HTMLDivElement | null>(null);
	const items = useNeedsYouItems(open !== null);
	const strip = useMemo(() => buildDenStrip(api.wolves, api.threads, items), [api.wolves, api.threads, items]);
	const current = strip.find((s) => s.wolf === open) ?? null;

	useEffect(() => {
		if (open === null) return;
		const key = (e: KeyboardEvent) => void (e.key === "Escape" && setOpen(null));
		const down = (e: Event) => void (boxRef.current && !boxRef.current.contains(e.target as Node) && setOpen(null));
		document.addEventListener("keydown", key);
		document.addEventListener("pointerdown", down);
		return () => {
			document.removeEventListener("keydown", key);
			document.removeEventListener("pointerdown", down);
		};
	}, [open]);
	// A wolf that leaves the strip (went offline, its cards were answered) takes its sheet with it.
	useEffect(() => {
		if (open !== null && !current) setOpen(null);
	}, [open, current]);

	if (strip.length === 0) return null;
	const answer = (row: DenRow) => {
		const t = api.threads[row.wolf]?.find((x) => x.id === row.threadId);
		setOpen(null);
		if (t && (t.kind === "home" || t.kind === "feature") && !t.parentThreadId) api.attach({ wolf: row.wolf, threadId: row.threadId });
		else router.push(row.href);
	};
	return (
		<div ref={boxRef} data-testid="den-strip" className="relative flex items-center justify-center gap-3 px-2 pb-2 pt-1">
			{current && (
				<div
					role="dialog"
					aria-label={`${current.wolf} needs you`}
					data-testid="den-sheet"
					className={cn(ZC.menu, "absolute bottom-full left-1/2 mb-2 flex max-h-[50dvh] -translate-x-1/2 flex-col overflow-y-auto rounded-xl border bg-popover/95 p-2.5 shadow-lg backdrop-blur-xl motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200", phone ? "w-[min(370px,calc(100vw-20px))]" : "w-[380px] max-w-[calc(100vw-20px)]")}
				>
					<div className="mb-1 flex items-center gap-1.5 font-ui text-sm" style={{ color: current.color }}>
						<b>{current.wolf}</b>
						<span className="text-xs text-muted-foreground">needs you</span>
					</div>
					{current.rows.length === 0 && <p className="py-2 font-ui text-xs text-muted-foreground">{current.needsYou > 0 ? "Loading…" : "Nothing waiting."}</p>}
					{current.rows.map((r) => (
						<div key={`${r.threadId}:${r.callId}`} data-testid="den-row" className="flex items-center gap-2 border-t py-1.5 first:border-t-0">
							<a
								href={r.href}
								onClick={(e) => {
									e.preventDefault();
									setOpen(null);
									router.push(r.href);
								}}
								className="flex min-w-0 flex-1 flex-col rounded-md px-1 py-0.5 hover:bg-accent max-md:min-h-11 max-md:justify-center"
							>
								<span className="truncate font-ui text-xs font-medium">{r.title}</span>
								<span className="line-clamp-2 font-ui text-xs text-muted-foreground">{r.summary}</span>
							</a>
							<Hint label="Answer">
								<button type="button" aria-label={`Answer ${r.title}`} onClick={() => answer(r)} className="flex size-8 shrink-0 items-center justify-center rounded-full text-amber-500 hover:bg-accent max-md:size-11">
									<MessageCircleQuestionIcon aria-hidden className="size-4" />
								</button>
							</Hint>
						</div>
					))}
				</div>
			)}
			{strip.map((s) => (
				<Hint key={s.wolf} label={s.wolf}>
					<button
						type="button"
						data-testid="den-wolf"
						data-wolf={s.wolf}
						data-working={s.working ? "true" : undefined}
						aria-label={denLabel(s)}
						aria-expanded={open === s.wolf}
						onClick={() => setOpen((cur) => (cur === s.wolf ? null : s.wolf))}
						style={{ color: s.color }}
						className={cn("relative flex size-[34px] shrink-0 items-center justify-center rounded-full border bg-card/70 backdrop-blur hover:bg-accent max-md:size-11", open === s.wolf && "border-current bg-accent")}
						{...(open === s.wolf ? { "data-selected": "true" } : {})}
					>
						<PawPrintIcon aria-hidden className="size-5" />
						{s.working && <i aria-hidden data-testid="den-working" className="absolute bottom-px right-px size-[7px] rounded-full bg-current ring-2 ring-card motion-safe:animate-pulse" />}
						{s.needsYou > 0 && (
							<b data-testid="den-badge" className="absolute -right-1.5 -top-[5px] flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 font-ui text-[11px] font-bold leading-none text-white ring-2 ring-card">
								{s.needsYou}
							</b>
						)}
					</button>
				</Hint>
			))}
		</div>
	);
}
