import { type RefObject } from "react";
import { type SessionScrollContext } from "@/components/session-navigation";
export declare const SESSION_FIND_HIGHLIGHT = "lh-session-find";
export declare const SESSION_FIND_ACTIVE_HIGHLIGHT = "lh-session-find-active";
export declare function injectFindStyles(): void;
export declare function clearSessionFindHighlights(): void;
/** One-Esc law: a surfaced menu/dialog/cheat sheet outranks this non-modal
 * bar, regardless of where focus happened to be left. Closed Radix exits
 * must not block Find once they have stopped being a surfaced layer. */
export declare function sessionFindHasForegroundLayer(doc: Document): boolean;
/** Mounted for the lifetime of ONE Chat (which is keyed by chatId). Closing
 * keeps the query/reading position; changing sessions resets all local state.
 * The bar lives outside scopeRef, so it never finds its own query or count. */
export declare function SessionFind({ scopeRef, scrollContextRef }: {
    scopeRef: RefObject<HTMLDivElement | null>;
    scrollContextRef: RefObject<SessionScrollContext | null>;
}): any;
//# sourceMappingURL=session-find.d.ts.map