"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BrailleSpinner } from "@/components/braille-spinner";
import { usePanelHost, usePanelState } from "@/components/panel-host";
import { useOptionalServerEvent } from "@/components/server-events";
import { compactUrl, contextUrl } from "@/components/thread/thread-transport";
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

/** `8× compacted · last 06:20`: the secondary detail under the Context row; undefined when never compacted. */
export function compactionDetail(c: ThreadContext): string | undefined {
	if (c.compactions.count === 0) return undefined;
	return `${c.compactions.count}× compacted${c.compactions.lastAt ? ` · last ${clock(c.compactions.lastAt)}` : ""}`;
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
export function ContextBar({ c }: { c: ThreadContext }) {
	const max = c.window ?? Math.max(c.tokens, 1);
	const pct = (n: number) => `${Math.min(100, (n / max) * 100)}%`;
	return (
		<div data-testid="context-bar" className="relative h-1.5 w-full rounded bg-accent">
			<div data-testid="context-bar-fill" className={`h-full rounded ${pastStartAt(c) ? "bg-amber-500" : "bg-foreground/60"}`} style={{ width: pct(c.tokens) }} />
			{c.startAt !== undefined && <div data-testid="context-bar-start" title={`summary starts at ${formatTokens(c.startAt)}`} className="absolute top-[-2px] h-2.5 w-px bg-amber-500" style={{ left: pct(c.startAt) }} />}
			{c.waitAt !== undefined && <div data-testid="context-bar-wait" title={`generation waits at ${formatTokens(c.waitAt)}`} className="absolute top-[-2px] h-2.5 w-px bg-red-500" style={{ left: pct(c.waitAt) }} />}
		</div>
	);
}

/**
 * The thread header's context chip (`312k / 1M · 2× compacted 14:05` plus a small fill bar and the percentage of the
 * window): amber past the background threshold, `summarising…` with the braille spinner while compacting. Click toggles
 * the Memory panel, whose Context row holds the Compact button. It always renders: without context (loading or a failed
 * fetch) it reads `context —`, muted, with no bar, so the panel stays reachable.
 */
export function ThreadContextChip({ wolf, slug, threadId, refreshKey }: { wolf: string; slug: string; threadId: string; refreshKey?: unknown }) {
	const { ctx, compacting } = useThreadContext(wolf, slug, threadId, refreshKey);
	const panels = usePanelHost();
	const { open, selected } = usePanelState();
	const amber = ctx ? pastStartAt(ctx) : false;
	const shown = open && selected === "memory";
	const pct = ctx?.window ? Math.min(100, Math.round((ctx.tokens / ctx.window) * 100)) : undefined;
	return (
		<div className="relative ml-auto shrink-0 max-md:min-w-0 max-md:shrink" data-testid="context-chip">
			<button
				type="button"
				data-testid="context-chip-button"
				data-amber={amber || undefined}
				data-compacting={compacting || undefined}
				aria-pressed={shown}
				title="Thread context: toggle the Memory panel"
				onClick={() => (shown ? panels.closePanel() : void panels.openPanel("memory"))}
				className={`flex max-md:max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 font-mono text-xs hover:bg-accent ${amber ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}
			>
				{pct !== undefined && (
					<span aria-hidden className="h-1.5 w-8 shrink-0 overflow-hidden rounded bg-accent" data-testid="context-chip-bar">
						<span className={`block h-full ${amber ? "bg-amber-500" : "bg-foreground/60"}`} style={{ width: `${pct}%` }} />
					</span>
				)}
				<span data-testid="context-label" className="max-md:truncate">{ctx ? contextLabel(ctx) : "context —"}</span>
				{pct !== undefined && <span data-testid="context-pct">{pct}%</span>}
				{compacting && (
					<span data-testid="context-summarising" className="flex items-center gap-1">
						{"· summarising…"}
						<BrailleSpinner label="Summarising" className="h-3" />
					</span>
				)}
			</button>
		</div>
	);
}
