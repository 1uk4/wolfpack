"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BrailleSpinner } from "@/components/braille-spinner";
import { usePopoverDismiss } from "@/components/popover-dismiss";
import { useOptionalServerEvent } from "@/components/server-events";
import { compactUrl, contextUrl } from "@/components/thread-transport";
import type { ThreadContext } from "@wolfpack/client";

/** 312000 → "312k", 1000000 → "1M", 1500000 → "1.5M". */
export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(n);
}

function clock(iso: string): string {
	const d = new Date(iso);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** `312k / 1M · 2× compacted 14:05` (the window and the compaction part are left out when unknown / zero). */
export function contextLabel(c: ThreadContext): string {
	const size = c.window ? `${formatTokens(c.tokens)} / ${formatTokens(c.window)}` : formatTokens(c.tokens);
	return c.compactions.count > 0 ? `${size} · ${c.compactions.count}× compacted${c.compactions.lastAt ? ` ${clock(c.compactions.lastAt)}` : ""}` : size;
}

/** Past the background threshold: the summary is due (or running). */
export function pastStartAt(c: ThreadContext): boolean {
	return c.startAt !== undefined && c.tokens > c.startAt;
}

const REFRESH_GAP_MS = 1000;
const POLL_MS = 1500;
const HARD_TIMEOUT_MS = 120_000;

/**
 * The thread's context stats: fetched on mount, when a turn ends (`refreshKey`), on a thread-updated of this thread
 * (wolfd announces a compaction's start and finish that way), and on focus. `compact()` posts the request and keeps
 * polling until the compaction is done, so `inFlight` covers the gap before the wolf reports `compacting`.
 */
export function useThreadContext(wolf: string, slug: string, threadId: string, refreshKey?: unknown) {
	const [ctx, setCtx] = useState<ThreadContext>();
	const [inFlight, setInFlight] = useState(false);
	const [error, setError] = useState<string>();
	const seq = useRef(0);
	const last = useRef(0);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const watch = useRef<{ count: number; seen: boolean; polls: number } | null>(null);

	const fetchNow = useCallback(async () => {
		const n = ++seq.current;
		last.current = Date.now();
		try {
			const res = await fetch(contextUrl(wolf, slug));
			const w = watch.current;
			if (w) w.polls++;
			if (!res.ok || n !== seq.current) return;
			const next = (await res.json()) as ThreadContext;
			setCtx(next);
			if (w) {
				if (next.compacting) w.seen = true;
				if (!next.compacting && (w.seen || next.compactions.count !== w.count || w.polls >= 3)) {
					watch.current = null;
					setInFlight(false);
				}
			}
		} catch {
			/* the next trigger refetches */
		}
	}, [wolf, slug]);
	const refresh = useCallback(() => {
		if (timer.current) return;
		const wait = Math.max(0, last.current + REFRESH_GAP_MS - Date.now());
		timer.current = setTimeout(() => {
			timer.current = undefined;
			void fetchNow();
		}, wait);
	}, [fetchNow]);

	useEffect(() => {
		refresh();
	}, [refresh, refreshKey]);
	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
			timer.current = undefined;
		},
		[],
	);
	useEffect(() => {
		window.addEventListener("focus", refresh);
		return () => window.removeEventListener("focus", refresh);
	}, [refresh]);
	useEffect(() => {
		if (!inFlight) return;
		const t = setInterval(refresh, POLL_MS);
		// Hard stop: a compaction that never reports done must not leave the button stuck.
		const stop = setTimeout(() => {
			watch.current = null;
			setInFlight(false);
			setError("Compaction did not finish in time");
		}, HARD_TIMEOUT_MS);
		return () => {
			clearInterval(t);
			clearTimeout(stop);
		};
	}, [inFlight, refresh]);
	useOptionalServerEvent("thread-updated", (p) => {
		if (p.wolf === wolf && p.thread.id === threadId) refresh();
	});

	const compact = useCallback(
		async (instructions?: string): Promise<boolean> => {
			setError(undefined);
			setInFlight(true);
			watch.current = { count: ctx?.compactions.count ?? 0, seen: false, polls: 0 };
			try {
				const res = await fetch(compactUrl(wolf, slug), { method: "POST", body: JSON.stringify(instructions?.trim() ? { instructions: instructions.trim() } : {}) });
				if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
				refresh();
				return true;
			} catch (e) {
				watch.current = null;
				setInFlight(false);
				setError(e instanceof Error ? e.message : String(e));
				return false;
			}
		},
		[wolf, slug, ctx, refresh],
	);

	return { ctx, compacting: inFlight || ctx?.compacting === true, error: error ?? (ctx?.compactError ? `Compaction failed: ${ctx.compactError}` : undefined), compact };
}

/** A small bar: tokens filled, ticks at the background threshold (startAt), the wait threshold and the window's end. */
function ContextBar({ c }: { c: ThreadContext }) {
	const max = c.window ?? Math.max(c.tokens, 1);
	const pct = (n: number) => `${Math.min(100, (n / max) * 100)}%`;
	return (
		<div data-testid="context-bar" className="relative h-2 w-full rounded bg-accent">
			<div data-testid="context-bar-fill" className={`h-full rounded ${pastStartAt(c) ? "bg-amber-500" : "bg-foreground/60"}`} style={{ width: pct(c.tokens) }} />
			{c.startAt !== undefined && <div data-testid="context-bar-start" title={`summary starts at ${formatTokens(c.startAt)}`} className="absolute top-[-2px] h-3 w-px bg-amber-500" style={{ left: pct(c.startAt) }} />}
			{c.waitAt !== undefined && <div data-testid="context-bar-wait" title={`generation waits at ${formatTokens(c.waitAt)}`} className="absolute top-[-2px] h-3 w-px bg-red-500" style={{ left: pct(c.waitAt) }} />}
		</div>
	);
}

/**
 * The thread header's context chip (`312k / 1M · 2× compacted 14:05`): amber past the background threshold,
 * `summarising…` with the braille spinner while compacting. Click opens the popover: bar, counts, optional
 * instructions and "Compact now" (enabled while a turn runs).
 */
export function ThreadContextChip({ wolf, slug, threadId, refreshKey }: { wolf: string; slug: string; threadId: string; refreshKey?: unknown }) {
	const { ctx, compacting, error, compact } = useThreadContext(wolf, slug, threadId, refreshKey);
	const [open, setOpen] = useState(false);
	const [instructions, setInstructions] = useState("");
	const rootRef = useRef<HTMLDivElement>(null);
	usePopoverDismiss(rootRef, open, () => setOpen(false));
	if (!ctx) return null;
	const amber = pastStartAt(ctx);
	return (
		<div ref={rootRef} className="relative ml-auto shrink-0" data-testid="context-chip">
			<button
				type="button"
				data-testid="context-chip-button"
				data-amber={amber || undefined}
				data-compacting={compacting || undefined}
				aria-expanded={open}
				aria-haspopup="dialog"
				title="Thread context"
				onClick={() => setOpen((v) => !v)}
				className={`flex items-center gap-1.5 rounded-md px-1.5 py-1 font-mono text-xs hover:bg-accent ${amber ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}
			>
				<span data-testid="context-label">{contextLabel(ctx)}</span>
				{compacting && (
					<span data-testid="context-summarising" className="flex items-center gap-1">
						{"· summarising…"}
						<BrailleSpinner label="Summarising" className="h-3" />
					</span>
				)}
			</button>
			{open && (
				<div role="dialog" aria-label="Thread context" data-testid="context-popover" className="absolute right-0 top-full z-50 mt-1 flex w-80 flex-col gap-2 rounded-lg border border-border bg-popover p-3 text-xs shadow-lg">
					<div className="flex items-baseline justify-between">
						<span className="font-medium text-foreground">Context</span>
						<span data-testid="context-popover-size" className="font-mono text-muted-foreground">{ctx.window ? `${formatTokens(ctx.tokens)} / ${formatTokens(ctx.window)}` : formatTokens(ctx.tokens)}</span>
					</div>
					<ContextBar c={ctx} />
					<div className="flex flex-col gap-0.5 text-muted-foreground">
						{ctx.startAt !== undefined && <span data-testid="context-start">Summary starts at {formatTokens(ctx.startAt)}</span>}
						{ctx.waitAt !== undefined && <span data-testid="context-wait">A turn waits for it at {formatTokens(ctx.waitAt)}</span>}
						<span data-testid="context-count">
							{ctx.compactions.count === 0 ? "Not compacted yet" : `Compacted ${ctx.compactions.count}×${ctx.compactions.lastAt ? `, last at ${clock(ctx.compactions.lastAt)}` : ""}`}
						</span>
					</div>
					<textarea
						data-testid="context-instructions"
						value={instructions}
						onChange={(e) => setInstructions(e.target.value)}
						placeholder="Optional: what the summary should keep"
						rows={2}
						className="w-full resize-none rounded-md border border-border bg-background p-1.5 text-xs"
					/>
					{error && <div data-testid="context-error" role="alert" className="text-destructive">{error}</div>}
					<button
						type="button"
						data-testid="context-compact"
						disabled={compacting}
						onClick={() => void compact(instructions).then((ok) => ok && setInstructions(""))}
						className="flex items-center justify-center gap-1.5 rounded-md border border-border px-2 py-1 hover:bg-accent disabled:opacity-60"
					>
						{compacting ? (
							<>
								<BrailleSpinner label="Summarising" className="h-3" />
								Summarising…
							</>
						) : (
							"Compact now"
						)}
					</button>
				</div>
			)}
		</div>
	);
}
