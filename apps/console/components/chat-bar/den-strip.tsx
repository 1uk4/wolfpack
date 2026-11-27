"use client";

/**
 * The den strip (work-wolfpack-XR2Jmxf, work-wolfpack-ftBY9Qv): a row of wolf buttons on top of the chat bar, floating or docked. Each button is the
 * wolf's colour, wears a red badge with the cards waiting on the owner and a pulsing dot while the wolf works. A click toggles that wolf's context
 * tree (components/chat-bar/context-tree.tsx), which opens inside the bar. While the chat floats over another thread's page (`swap`), the attached
 * wolf's button is the swap control instead: one click docks the page's thread, no tree. The model is src/core/thread/den-strip.ts.
 * The strip sits inside the bar's box, so `--chat-bar-top` (the bar's top) counts it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRightIcon } from "lucide-react";
import { useAttachedThread } from "@/components/chat-bar/attached-thread";
import { WolfpackMark } from "@/components/shell/wolfpack-mark";
import { useOptionalServerEvent } from "@/components/shell/server-events";
import { Hint } from "@/components/ui/hint";
import { cn } from "@/lib/utils";
import { buildDenStrip, denLabel, type NeedsYouItem } from "@/src/core";

/** The pending cards from /api/needs-you, fetched while the sheet is open and refetched on every needs-you-changed (no polling). */
export function useNeedsYouItems(enabled: boolean): NeedsYouItem[] {
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

/** The chat floats over another thread's page: the attached wolf's button is the swap control (`label` names it, `onSwap` brings the attached thread into the page and docks the bar). */
export interface DenSwap {
	wolf: string;
	label: string;
	needsYou: boolean;
	busy: boolean;
}

interface Props {
	swap?: DenSwap | null;
	onSwap?: () => void;
	/** The wolf whose context tree is open (the bar keeps this, so its header's wolf name opens the same tree). */
	open: string | null;
	setOpen: (wolf: string | null) => void;
}

export function DenStrip({ swap = null, onSwap, open, setOpen }: Props) {
	const api = useAttachedThread()!;
	const items = useNeedsYouItems(open !== null);
	const strip = useMemo(() => buildDenStrip(api.wolves, api.threads, items, swap?.wolf ?? null, api.attached?.wolf ?? null), [api.wolves, api.threads, items, swap?.wolf, api.attached?.wolf]);
	// A wolf that leaves the strip (went offline, its cards were answered) takes its tree with it.
	useEffect(() => {
		if (open !== null && !strip.some((s) => s.wolf === open)) setOpen(null);
	}, [open, strip, setOpen]);

	if (strip.length === 0) return null;
	return (
		<div data-testid="den-strip" className="relative flex items-center justify-center gap-3 px-2 pb-2 pt-1">
			{strip.map((s) => (
					<Hint key={s.wolf} label={s.swap && swap ? swap.label : s.wolf}>
						<button
							type="button"
							data-testid={s.swap && swap ? "chat-bar-swap" : "den-wolf"}
							data-wolf={s.wolf}
							data-working={s.working ? "true" : undefined}
							aria-label={s.swap && swap ? swap.label : denLabel(s)}
							data-swap={s.swap && swap ? "true" : undefined}
							data-needs-you={s.swap && swap?.needsYou ? "true" : undefined}
							disabled={s.swap && swap?.busy ? true : undefined}
							aria-expanded={open === s.wolf}
							onClick={() => {
								if (s.swap && swap) {
									setOpen(null);
									onSwap?.();
								} else setOpen(open === s.wolf ? null : s.wolf);
							}}
							style={{ color: s.color }}
							className={cn("relative flex size-[34px] shrink-0 items-center justify-center rounded-full border bg-card/70 backdrop-blur hover:bg-accent max-md:size-11", open === s.wolf && "border-current bg-accent")}
							{...(open === s.wolf ? { "data-selected": "true" } : {})}
						>
							{s.swap && swap ? <ArrowLeftRightIcon aria-hidden className="size-5" /> : <WolfpackMark className="size-5" />}
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
