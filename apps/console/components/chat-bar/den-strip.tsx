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
import { buildDenStrip, denLabel, wolfColorStyle, type NeedsYouItem } from "@/src/core";

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
	/** Phone: small avatars (28px drawn, 44px tap area) that sit on the chat header line instead of a row of their own. */
	inline?: boolean;
}

export function DenStrip({ swap = null, onSwap, open, setOpen, inline = false }: Props) {
	const api = useAttachedThread()!;
	const items = useNeedsYouItems(open !== null);
	// While a swap is on offer the swap icon follows the pointer: it is drawn on the hovered wolf, else on the attached wolf. A click on the icon swaps the chat to that wolf's home thread; with no hover it docks the page's thread (onSwap).
	const [hovered, setHovered] = useState<string | null>(null);
	const strip = useMemo(() => buildDenStrip(api.wolves, api.threads, items, swap?.wolf ?? null, api.attached?.wolf ?? null), [api.wolves, api.threads, items, swap?.wolf, api.attached?.wolf]);
	// A wolf that leaves the strip (went offline, its cards were answered) takes its tree with it.
	useEffect(() => {
		if (open !== null && !strip.some((s) => s.wolf === open)) setOpen(null);
	}, [open, strip, setOpen]);

	// Phone header line: only the wolf the chat is on gets an avatar; the others fold into one "+N" button (it wears a red dot while any of them needs you) that opens them in a small tray above.
	const [more, setMore] = useState(false);
	const current = strip.find((s) => s.swap || s.wolf === api.attached?.wolf) ?? strip[0];
	const visible = inline ? strip.filter((s) => s === current) : strip;
	const rest = inline ? strip.filter((s) => s !== current) : [];
	const box = useRef<HTMLDivElement | null>(null);
	// The tray closes on an outside press, on Escape, and after a wolf is picked.
	useEffect(() => {
		if (!more) return;
		const onDown = (e: Event) => {
			if (box.current && !box.current.contains(e.target as Node)) setMore(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.stopPropagation();
			setMore(false);
		};
		document.addEventListener("pointerdown", onDown);
		document.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("pointerdown", onDown);
			document.removeEventListener("keydown", onKey, true);
		};
	}, [more]);
	const restNeeds = rest.reduce((n, s) => n + s.needsYou, 0);
	const item = (s: (typeof strip)[number]) => (
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
							onMouseEnter={() => setHovered(s.wolf)}
							onMouseLeave={() => setHovered((h) => (h === s.wolf ? null : h))}
							onClick={() => {
								setMore(false);
								if (s.swap && swap) {
									setOpen(null);
									onSwap?.();
								} else if (swap && hovered === s.wolf && s.homeThreadId) {
									// The swap icon is on this hovered wolf: swap the chat to it (its home thread, the one the tree leads with).
									setOpen(null);
									api.attach({ wolf: s.wolf, threadId: s.homeThreadId });
								} else setOpen(open === s.wolf ? null : s.wolf);
							}}
							data-wolf-color={s.colorKey}
							style={{ ...wolfColorStyle(s.colorKey), color: "var(--wolf-accent)" }}
							className={inline ? "group relative flex size-11 shrink-0 items-center justify-center rounded-full" : cn("relative flex size-[34px] shrink-0 items-center justify-center rounded-full border bg-card/70 backdrop-blur hover:bg-accent max-md:size-11", open === s.wolf && "border-current bg-accent")}
							{...(open === s.wolf ? { "data-selected": "true" } : {})}
						>
							<span className={inline ? cn("relative flex size-7 items-center justify-center rounded-full border bg-card/70 backdrop-blur group-hover:bg-accent", open === s.wolf && "border-current bg-accent") : "contents"}>
							{swap && (hovered ?? swap.wolf) === s.wolf ? <ArrowLeftRightIcon aria-hidden data-testid="den-swap-icon" className={inline ? "size-4" : "size-5"} /> : <WolfpackMark className={inline ? "size-4" : "size-5"} />}
							{s.working && <i aria-hidden data-testid="den-working" className="absolute bottom-px right-px size-[7px] rounded-full bg-current ring-2 ring-card motion-safe:animate-pulse" />}
							{s.needsYou > 0 && (
								<b data-testid="den-badge" className="absolute -right-1.5 -top-[5px] flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 font-ui text-[11px] font-bold leading-none text-white ring-2 ring-card">
									{s.needsYou}
								</b>
							)}
							</span>
						</button>
					</Hint>
	);
	if (strip.length === 0) return null;
	return (
		<div ref={box} data-testid="den-strip" data-inline={inline ? "true" : undefined} className={inline ? "relative flex shrink-0 items-center" : "relative flex items-center justify-center gap-3 px-2 pb-2 pt-1"}>
			{visible.map(item)}
			{rest.length > 0 && (
				<Hint label={`${rest.length} more wolf${rest.length === 1 ? "" : "s"}`}>
					<button
						type="button"
						data-testid="den-more"
						aria-label={`${rest.length} more wolf${rest.length === 1 ? "" : "s"}${restNeeds > 0 ? `, ${restNeeds} waiting for you` : ""}`}
						aria-expanded={more}
						onClick={() => setMore((m) => !m)}
						className="relative flex size-11 shrink-0 items-center justify-center rounded-full font-ui text-xs font-medium text-muted-foreground hover:bg-accent"
					>
						+{rest.length}
						{restNeeds > 0 && <b data-testid="den-more-badge" className="absolute right-0.5 top-1.5 size-2.5 rounded-full bg-red-500 ring-2 ring-card" />}
					</button>
				</Hint>
			)}
			{more && rest.length > 0 && (
				<div data-testid="den-more-tray" className="absolute bottom-full left-0 z-10 mb-1 flex items-center rounded-xl border bg-card/90 p-0.5 shadow-lg backdrop-blur-xl">
					{rest.map(item)}
				</div>
			)}
		</div>
	);
}
