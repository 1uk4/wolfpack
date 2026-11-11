"use client";

/**
 * The node card's route section: step indicator, ← / → buttons (and the same
 * keys while the card is mounted, i.e. while the graph holds the selection),
 * and a dropdown of the step's nodes at a parallel step. Presentational over
 * the route + cursor models (src/core/work-route.ts); the graph view owns the
 * cursor state.
 */
import { useEffect } from "react";
import { cursorChoose, cursorNext, cursorPrev, type RouteCursor, type WorkRoute } from "@/src/core/work-route";

export interface RouteNavModel {
	route: WorkRoute;
	cursor: RouteCursor;
	/** Display name / stage of a raw work id. */
	label: (rawId: string) => string;
	stage: (rawId: string) => string;
	onCursor: (next: RouteCursor) => void;
}

/** Arrow keys must not steal from text entry (or a select's own arrows). */
export function isEditableTarget(t: EventTarget | null): boolean {
	const el = t as { tagName?: string; isContentEditable?: boolean } | null;
	const tag = el?.tagName?.toUpperCase();
	return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable === true;
}

export function RouteNav({ nav }: { nav: RouteNavModel }) {
	const { route, cursor, onCursor } = nav;
	const total = route.steps.length;
	const step = route.steps[cursor.step];

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
			if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
			if (isEditableTarget(e.target)) return;
			e.preventDefault();
			onCursor(e.key === "ArrowRight" ? cursorNext(route, cursor) : cursorPrev(route, cursor));
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [route, cursor, onCursor]);

	if (!step) return null;
	const stage = cursor.node ? nav.stage(cursor.node).replace(/_/g, " ") : "";
	const btn = "rounded-lg border px-2 py-0.5 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-40";
	return (
		<div className="mt-3 flex flex-col gap-1.5 border-t pt-3" data-testid="route-nav">
			<div className="flex items-center justify-between gap-2">
				<button type="button" aria-label="Previous step" data-testid="route-prev" disabled={cursor.step <= 0} onClick={() => onCursor(cursorPrev(route, cursor))} className={btn}>
					←
				</button>
				<span className="min-w-0 truncate text-xs text-muted-foreground" data-testid="route-step">
					{`Step ${cursor.step + 1} of ${total}${stage ? ` · ${stage}` : ""}`}
				</span>
				<button type="button" aria-label="Next step" data-testid="route-next" disabled={cursor.step >= total - 1} onClick={() => onCursor(cursorNext(route, cursor))} className={btn}>
					→
				</button>
			</div>
			{step.parallel && (
				<select
					aria-label="Parallel at this step"
					data-testid="route-parallel"
					value={cursor.node ?? ""}
					onChange={(e) => onCursor(cursorChoose(route, cursor, e.target.value))}
					className="h-7 w-full rounded-lg border bg-background px-1 text-xs"
				>
					{step.nodes.map((id) => (
						<option key={id} value={id}>
							{nav.label(id)}
						</option>
					))}
				</select>
			)}
			{route.warnings.map((w) => (
				<div key={w} className="text-[11px] text-amber-600 dark:text-amber-400" data-testid="route-warning">
					{w}
				</div>
			))}
		</div>
	);
}
