"use client";

/**
 * The floating chat collapsed to a small round icon: the Wolfpack mark, the attached wolf's status dot and the needs-you count.
 * Drag it anywhere (its spot is remembered per device, bar-icon.ts); on a phone it snaps to the nearer screen edge and keeps off the notch
 * and home bar. A press that moves more than a few px is a drag, never a tap; a tap (or Enter) expands the bar again.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { clampIconPos, isDrag, loadIconPos, saveIconPos, snapIconToEdge, type Insets, type IconPos, type KeyValueStore, type Viewport } from "@/src/core";
import { WolfpackMark } from "@/components/shell/wolfpack-mark";
import { Hint } from "@/components/ui/hint";
import { CompactMeter, type Dictation } from "@/components/composer/dictation";
import { cn } from "@/lib/utils";

const store = (): KeyValueStore | null => {
	try {
		return typeof window === "undefined" ? null : (window.localStorage ?? null);
	} catch {
		return null;
	}
};
const viewport = (): Viewport => ({ width: window.innerWidth, height: window.innerHeight });

/** env(safe-area-inset-*) in px: CSS env() is not readable from script, so measure a hidden probe's padding. */
function readInsets(): Insets {
	if (typeof window.getComputedStyle !== "function") return { top: 0, right: 0, bottom: 0, left: 0 }; // a non-browser DOM: no notch
	const probe = document.createElement("div");
	probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
	document.body.appendChild(probe);
	const cs = window.getComputedStyle(probe);
	const px = (v: string) => Number.parseFloat(v) || 0;
	const insets = { top: px(cs.paddingTop), right: px(cs.paddingRight), bottom: px(cs.paddingBottom), left: px(cs.paddingLeft) };
	probe.remove();
	return insets;
}

const ARROW_STEP = 16;

export function BarIcon({ phone, label, color, wolfStatus, needsYou, working, dictation, onExpand }: {
	phone: boolean;
	label: string;
	color: string;
	/** The attached wolf's roster status ("online" when the roster gives none). */
	wolfStatus: string;
	/** Threads waiting on the owner, across wolves. */
	needsYou: number;
	working: boolean;
	dictation: Dictation;
	onExpand: () => void;
}) {
	const [pos, setPos] = useState<IconPos | null>(null);
	const [dragging, setDragging] = useState(false);
	const drag = useRef<{ id: number; px: number; py: number; ox: number; oy: number; moved: boolean; at: IconPos } | null>(null);
	const justDragged = useRef(false);
	const swallow = useRef<ReturnType<typeof setTimeout> | null>(null);
	const insets = useRef<Insets>({ top: 0, right: 0, bottom: 0, left: 0 });
	const phoneRef = useRef(phone);
	phoneRef.current = phone;

	const place = (at: IconPos, toPhone: boolean) => (toPhone ? snapIconToEdge(at, viewport(), insets.current) : clampIconPos(at, viewport(), insets.current));

	// Before the first paint: read the safe area and the remembered spot (snapped to an edge on a phone), then keep the icon on screen when the window resizes.
	useLayoutEffect(() => {
		insets.current = readInsets();
		setPos(place(loadIconPos(store(), viewport(), insets.current), phoneRef.current));
		const onResize = () => {
			insets.current = readInsets();
			setPos((p) => (p ? place(p, phoneRef.current) : p));
		};
		window.addEventListener("resize", onResize);
		return () => {
			window.removeEventListener("resize", onResize);
			if (swallow.current) clearTimeout(swallow.current);
		};
	}, []);
	// Crossing the phone breakpoint re-places the icon: snapped to an edge on a phone, clamped off it.
	useEffect(() => {
		setPos((p) => (p ? place(p, phone) : p));
	}, [phone]);

	const finish = (at: IconPos) => {
		const next = place(at, phone);
		setPos(next);
		saveIconPos(store(), next);
	};

	const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
		if (!pos || drag.current || (e.pointerType === "mouse" && e.button !== 0)) return; // a second touch is ignored while one is down
		drag.current = { id: e.pointerId, px: e.clientX, py: e.clientY, ox: pos.x, oy: pos.y, moved: false, at: pos };
		e.currentTarget.setPointerCapture?.(e.pointerId);
	};
	const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
		const d = drag.current;
		if (!d || e.pointerId !== d.id) return;
		const dx = e.clientX - d.px;
		const dy = e.clientY - d.py;
		if (!d.moved && !isDrag(dx, dy)) return;
		d.moved = true;
		d.at = clampIconPos({ x: d.ox + dx, y: d.oy + dy }, viewport(), insets.current);
		setDragging(true);
		setPos(d.at);
	};
	const onPointerEnd = (e: React.PointerEvent<HTMLButtonElement>) => {
		const d = drag.current;
		if (!d || e.pointerId !== d.id) return;
		drag.current = null;
		if (!d.moved) return;
		setDragging(false);
		finish(d.at);
		if (e.type === "pointercancel") return; // a cancelled touch sends no click to swallow
		// The click that ends a drag must not expand the bar; the flag lapses if the browser sends none.
		justDragged.current = true;
		if (swallow.current) clearTimeout(swallow.current);
		swallow.current = setTimeout(() => void (justDragged.current = false), 60);
	};
	// Arrows nudge within the screen; on release the phone icon snaps to the nearer edge like a drag does.
	const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
		const step = { ArrowLeft: [-ARROW_STEP, 0], ArrowRight: [ARROW_STEP, 0], ArrowUp: [0, -ARROW_STEP], ArrowDown: [0, ARROW_STEP] }[e.key];
		if (!step || !pos) return;
		e.preventDefault();
		const next = clampIconPos({ x: pos.x + step[0]!, y: pos.y + step[1]! }, viewport(), insets.current);
		setPos(next);
		saveIconPos(store(), next);
	};
	const onKeyUp = (e: React.KeyboardEvent<HTMLButtonElement>) => {
		if (!e.key.startsWith("Arrow") || !pos || !phone) return;
		finish(pos);
	};

	// Near the top the dictation meter would leave the screen: it flips below the icon.
	const nearTop = (pos?.y ?? Infinity) < 56;

	return (
		<div
			data-testid="chat-bar"
			data-state="minimized"
			data-dragging={dragging ? "true" : undefined}
			className={cn("fixed z-30 size-12", !dragging && "motion-safe:transition-[left,top] motion-safe:duration-200")}
			style={{ left: pos?.x ?? 0, top: pos?.y ?? 0, visibility: pos ? "visible" : "hidden" }}
		>
			{dictation.active && (
				<div data-testid="chat-bar-icon-meter" data-side={nearTop ? "below" : "above"} className={cn("pointer-events-none absolute left-1/2 -translate-x-1/2 rounded-full border bg-card px-2 py-1 shadow-md", nearTop ? "top-full mt-1.5" : "bottom-full mb-1.5")}>
					<CompactMeter dictation={dictation} />
				</div>
			)}
			<Hint label={label} side="top">
				<button
					type="button"
					data-testid="chat-bar-expand"
					aria-label={label}
					onClick={() => {
						if (justDragged.current) return void (justDragged.current = false);
						onExpand();
					}}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerEnd}
					onPointerCancel={onPointerEnd}
					onKeyDown={onKeyDown}
					onKeyUp={onKeyUp}
					style={{ borderColor: color }}
					className={cn(
						"relative flex size-12 touch-none select-none items-center justify-center rounded-full border bg-card/90 text-foreground shadow-lg backdrop-blur-md hover:bg-card focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
						dragging ? "cursor-grabbing" : "cursor-grab",
						dictation.active && "ring-2 ring-red-500/70",
					)}
				>
					<WolfpackMark className="size-6" />
					<span
						role="img"
						aria-label={wolfStatus === "offline" ? "offline" : "online"}
						data-testid="chat-bar-icon-dot"
						data-status={wolfStatus}
						className={cn("absolute bottom-0.5 right-0.5 size-3 rounded-full ring-2 ring-card", wolfStatus === "offline" ? "bg-muted-foreground/50" : "bg-emerald-500", working && "motion-safe:animate-pulse")}
					/>
					{needsYou > 0 && (
						<span data-testid="chat-bar-icon-count" aria-label={`${needsYou} waiting for you`} className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 px-1 font-ui text-[11px] font-semibold leading-none text-black">
							{needsYou}
						</span>
					)}
				</button>
			</Hint>
		</div>
	);
}
