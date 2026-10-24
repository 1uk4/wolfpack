import { type StickToBottomContext } from "use-stick-to-bottom";
export type SessionScrollContext = Pick<StickToBottomContext, "scrollRef" | "stopScroll">;
/** Scroll only the session's own containers (including tall question/code
 * areas), never sidebar/chrome. Inner containers move first, then the main
 * transcript. stopScroll releases the sticky-bottom animation BEFORE jumping. */
export declare function scrollSessionTarget(target: Range | HTMLElement, scope: HTMLElement, context: SessionScrollContext | null): void;
/** React owns message markup; this controller adds no messages or content.
 * Arrival on a full load is the browser's own hash scroll; this watcher owns
 * SPA arrivals (graph links) and later hash changes. The mount path polls on
 * a short interval ON PURPOSE: the transcript scroller's ref is attached by a
 * LATER SIBLING (StickToBottom.Content), hydration orderings vary, and a
 * frame-chained rAF proved cancellable mid-flight in dev (the owner's
 * every-link-lands-at-bottom report, 2026-10-13) — a synchronous tick that
 * retries until both elements exist has no cancellation window. */
export declare function SessionMessageNavigation(): null;
//# sourceMappingURL=session-navigation.d.ts.map