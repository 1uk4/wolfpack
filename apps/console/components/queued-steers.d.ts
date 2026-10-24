/**
 * THE QUEUED-STEER INDICATOR (owner spec 2026-10-03): steers sent but not
 * yet drained render as quiet one-liners ABOVE the composer shell —
 * right-aligned to where the shell's corner rounding starts, truncated
 * with an ellipsis, no background, no container, roughly half opacity.
 * Visible but very quiet; layout tunable later.
 *
 * A line dies the moment its card lands in the transcript: the drain's
 * verbatim message events upsert the real user card by the client-minted
 * id, and visibleQueuedSteers (session-core, pure) filters the queue
 * against the message ids. A steer parked server-side (stranded behind a
 * question) keeps its line — an honest "waiting for the next run".
 */
export interface QueuedSteerLine {
    id: string;
    text: string;
}
/** The pure body (SSR-pinnable): one right-aligned truncated line per
 *  queued steer, stacked. */
export declare function QueuedSteersBody({ steers }: {
    steers: QueuedSteerLine[];
}): any;
//# sourceMappingURL=queued-steers.d.ts.map