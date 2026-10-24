import { type LhMessage, type ModelSlotName } from "@/src/core";
/**
 * Server-sync channel for artifact renderers: the CENTRAL jobs poll in Chat
 * calls syncFromServer() when a background job settles — the wake turn's
 * steer + response are already persisted by then, so fresh messages replace
 * local state in one pull. sendText feeds the demo error-fix loop.
 * (contracts.ts "THE ASYNC PROTOCOL" §4.)
 */
export declare const ChatActionsContext: any;
/** The BYOK refusal envelope from the transport's error text: the
 *  DefaultChatTransport throws the 503 body VERBATIM as the error message,
 *  so the machine-readable {code, missing} shape survives to here. Real
 *  errors (any other text) read as null and keep the honest banner.
 *  Exported pure for tests. */
export declare function parseModelsRefusal(message: string | undefined): ModelSlotName[] | null;
/** The provider-key refusal's transport seam (zero-keys wave, Platform's
 *  66dbea9): same discipline as parseModelsRefusal — the 503 body rides
 *  the thrown error message verbatim, so the envelope's own matcher
 *  (core, invariant-tail) decides; the wording can never drift client-
 *  side. Exported pure for tests. */
export declare function parseProviderKeyRefusal(message: string | undefined): boolean;
/**
 * The teaching session. All chat state lives in useChat; the server persists
 * the canonical transcript after every turn.
 *
 * The bottom blob is ONE persistent shell whose contents swap (chat composer ↔
 * question dock ↔ collapsed bar). The shell is sticky INSIDE the scroller —
 * never overlapping the transcript at rest, never covering the scrollbar —
 * and DockOverlay animates its height on variant changes.
 */
export declare function Chat({ chatId, title, initialMessages, initialPrompt, initiallyInFlight, initiallyCompacting, initialConfigured, kind, }: {
    chatId: string;
    title: string;
    initialMessages: LhMessage[];
    /** The session kind (practice sessions, owner 2026-10-04): practice
     *  renders no phase chip (no probe→teach arc applies) and a Practice
     *  tag rides the header instead. */
    kind?: "teach" | "practice";
    initialPrompt?: string;
    /** A teacher turn is running server-side but attached to no client
     * (navigated away mid-turn, returned while in flight). */
    initiallyInFlight?: boolean;
    /** A compaction holds the chat's model gate at mount (navigated away
     * mid-compaction — the registry is live server state, the
     * compaction-changed event already fired). The transcript spinner
     * and send gates key on it. */
    initiallyCompacting?: boolean;
    /** slotsConfigured(server record) — the persistent setup CTA keys on
     *  it (BYOK, owner 2026-09-22). The server gate stays the truth; this
     *  only decides whether the pill rides the composer. */
    initialConfigured?: boolean;
}): any;
/**
 * The floating blob: ONE persistent shell, OVERLAID at the bottom of the
 * column (absolute — a sibling of the scroller, the use-stick-to-bottom
 * pattern; it replaced the old in-flow sticky dock, which died of the
 * fold-latency problem below). Contents swap between the chat composer and
 * the question dock; shell height morphs between variants (WAAPI, quick). A
 * spacer at the end of the transcript (rendered by ChatView from onReserve
 * reports) holds the dock's flow-space, so at-rest content scrolls fully
 * clear of the overlay.
 *
 * Why an overlay (owner, scroll round 1): an in-flow dock IS scroll geometry
 * — folding it shrinks the scroll content, so the fold had to wait until the
 * learner was a full dock-height past the bottom (any closer and the browser
 * clamp pinned them back, re-expanding the box: the oscillation). Decoupled
 * from the flow, the fold is VISUAL ONLY: it fires as soon as the learner
 * leaves the bottom, and the reserved tail only ever GROWS while a question
 * is open (a shrinking tail would reintroduce the clamp).
 *
 * Collapse: scroll up past COLLAPSE_DIST and the dock folds into a slim bar;
 * click it (or scroll back to the bottom) to re-expand. The question form
 * stays MOUNTED while collapsed (hidden, not unmounted) so a half-made
 * selection survives.
 */
/**
 * How a teach-phase question arrives (owner ruling, 2026-09-25): collapsed
 * behind the reveal button when it follows the composer — the learner
 * reads the teaching first — but OPEN when it follows another question
 * (a queued parallel check): the reading already happened, so there is
 * nothing left to wait for and the scroll height it already had is the
 * honest height.
 */
/** The layered-Esc ruling (owner, 2026-10-04): an open overlay claims Esc —
 *  closing itself — before the abort chain may open its confirm. A mermaid
 *  focus, the plan popup, or the setup dialog over a pending question must
 *  close the OVERLAY, never dismiss the question underneath. Priority is
 *  stacking order: the abort confirm (topmost, claims via its own dialog),
 *  then the session overlays (mermaid paints above plan — later in DOM),
 *  then setup (self-closing — the gate only must not fire), then the
 *  2026-10-02 abort chain proper (question before turn). */
export type EscAbortTarget = "mermaid" | "plan" | "setup" | "question" | "problem" | "turn" | null;
/**
* Does the ?prompt topic still owe its first send? The gate is "no real
* conversation yet" (no user/assistant message) — NOT emptiness: a
* session started with map picks carries a graph-context MARKER as
* message[0], and that scaffolding must never swallow the first send
* (owner report, 2026-10-04: the turn went dead behind it — the old
* `length === 0` check saw the marker and refused to fire).
*/
export declare function initialPromptOwed(messages: readonly {
    role: string;
}[], prompt: string | undefined): boolean;
export declare function escAbortTarget(s: {
    abortAsk: boolean;
    mermaidFocus: boolean;
    planOpen: boolean;
    setupOpen: boolean;
    pending: boolean;
    /** An active practice problem (practice sessions, 2026-10-04): Esc
     *  opens the discard confirm — below a pending question (the two
     *  never coexist, but the layering stays strict), above the turn
     *  abort (a live turn can be running BEHIND an idle problem only in
     *  teaching sessions — practice problems end their pose turns). */
    problem: boolean;
    busy: boolean;
}): EscAbortTarget;
export declare function revealArrival(wasQuestion: boolean): {
    expanded: boolean;
    revealed: boolean;
};
/**
 * A PROBE question's arrival state (flicker round, 2026-09-26): open iff
 * the learner is at the bottom following along; scrolled up in history →
 * arrive as the collapsed bar (owner ruling: "it should just remain
 * closed"). Decided DURING RENDER like the teach seam above — the old
 * after-paint effect painted one stale-open frame first (the box "opened
 * and immediately closed" when scrolled up). Pure for tests.
 */
export declare function probeArrivalExpanded(isAtBottom: boolean): boolean;
/**
 * The geometry-mute's growth rule (flicker round, 2026-09-26): a reserve
 * GROWTH while a question is pending is the dock stretching (the dictation
 * flush landing many lines at once) — the spacer lands in that commit, the
 * smooth catch-up lags by exactly the growth, and that lag is our own
 * motion, not the learner leaving, so the fold machine ignores scroll
 * events for the mute window after (reproduced d≈152 > COLLAPSE_DIST).
 * Shrinks never stamp — that path self-muted the at-bottom re-expand and
 * left the box stuck collapsed (resize round, verified live). Pure for
 * tests.
 */
export declare function shouldStampGeometryMute(nextH: number, prevH: number, pending: boolean): boolean;
//# sourceMappingURL=chat.d.ts.map