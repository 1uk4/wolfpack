import { noteSteerVisible } from "../jobs.ts";
import { ToolCallIdUniquifier } from "./call-ids.ts";
export function runPiTurn(spec) {
    const { agent, onError, onFinish, usedToolCallIds, updateFlushMs = 100 } = spec;
    const uniquifier = usedToolCallIds ? new ToolCallIdUniquifier(usedToolCallIds) : undefined;
    let settled = false;
    let sawAbort = false;
    // THE PER-TURN STATE LOG (memory-only — the settle-only disk writes
    // are unchanged). COMPACTION LAW (owner, 2026-10-09, supersedes the
    // 2026-09-25 unbounded-log ruling): settled events append verbatim;
    // in-flight `message_update` / `tool_execution_update` runs are reduced
    // to their LATEST member, replaced in place. Retention is bounded by
    // CONTENT (settled messages + one snapshot per streaming message), not
    // by chunk count — the quadratic blowup that froze parallel sessions is
    // structurally impossible now. The log dies with the turn at settle.
    const log = [];
    // Live-update slots: coalesce key → log index of the retained update.
    // One assistant message streams at a time (pi's strict per-step
    // start → updates → end ordering), so messages share one slot; parallel
    // tool executions each own theirs (toolCallId). End events free the slot
    // — a later update for the same key starts a fresh run.
    const updateSlots = new Map();
    // The coalescing queue for LIVE fan-out: key → latest event, flushed at
    // most once per flush window (Map preserves first-insertion order, so the
    // relative order of concurrent keys stays chronological).
    const pending = new Map();
    const subscribers = new Set();
    const coalesceKey = (event) => {
        if (event.type === "message_update")
            return "message";
        if (event.type === "tool_execution_update")
            return `tool:${event.toolCallId}`;
        return null;
    };
    // Send = compact the log + fan out to every live view. A view's own
    // enqueue failure (a cancelled reader) is swallowed by the view — the
    // turn must still settle; onFinish persists regardless of who watches.
    const send = (event) => {
        if (settled)
            return;
        const key = coalesceKey(event);
        if (key !== null) {
            // Retention: replace-in-place the run's latest snapshot.
            const idx = updateSlots.get(key);
            if (idx !== undefined)
                log[idx] = event;
            else {
                updateSlots.set(key, log.length);
                log.push(event);
            }
            // Fan-out: coalesced — latest wins, flushed at ≤1/window.
            pending.set(key, event);
            armFlush();
            return;
        }
        // A boundary event ends its update run (end supersedes the partial;
        // the slot frees for any future run of the same key).
        if (event.type === "message_end")
            updateSlots.delete("message");
        if (event.type === "tool_execution_end")
            updateSlots.delete(`tool:${event.toolCallId}`);
        // Strict per-subscriber ordering: anything still pending precedes
        // this boundary event on the wire, never after it.
        flushPending();
        log.push(event);
        for (const sub of subscribers)
            sub.push(event);
    };
    let flushTimer;
    const flushPending = () => {
        if (flushTimer !== undefined) {
            clearTimeout(flushTimer);
            flushTimer = undefined;
        }
        if (pending.size === 0)
            return;
        const batch = [...pending.values()];
        pending.clear();
        for (const sub of subscribers)
            for (const event of batch)
                sub.push(event);
    };
    const armFlush = () => {
        if (flushTimer !== undefined)
            return;
        flushTimer = setTimeout(() => {
            flushTimer = undefined;
            flushPending();
        }, updateFlushMs);
        // Never holds the process (or the test runner) open for a straggler.
        flushTimer.unref?.();
    };
    const closeAll = () => {
        if (settled)
            return;
        // Order to the very end: the last pending snapshot precedes [DONE].
        flushPending();
        settled = true;
        for (const sub of subscribers)
            sub.done();
        subscribers.clear();
    };
    // The settle seam: the record write is the agent's OWN final state
    // (native history — signatures, usage, provider stamps all real).
    // Copy the array: the agent may outlive this call's read.
    // 0.87.1 (transcript rework): the Agent seeds a leading SystemMessage
    // from initialState.systemPrompt (prompt + tool declarations) — it is
    // synthesized per turn and must NEVER persist (the record would bloat
    // with tool declarations AND replay would see messages[0] === system,
    // suppressing the fresh per-turn re-seed). Our app mints no system
    // messages of its own (the prompt is composed per turn), so dropping
    // the role wholesale is exact; revisit if prompt-updates ever land.
    const settleWith = () => {
        const settled_ = [...agent.state.messages].filter((m) => m.role !== "system");
        onFinish(uniquifier?.remapSettled(settled_) ?? settled_, sawAbort);
    };
    const handle = (event) => {
        // THE LACAN FIX: ids uniquify HERE, before any view — the one seam
        // every consumer downstream shares. No uniquifier → verbatim.
        const uniqued = uniquifier ? uniquifier.event(event) : event;
        // WIRE DIET: slim the one event pi double-stuffs — our views read
        // `message`, never `assistantMessageEvent` (same full partial twice).
        const wire = uniqued.type === "message_update"
            ? { type: "message_update", message: uniqued.message }
            : uniqued;
        send(wire);
        if (event.type === "message_end") {
            const m = event.message;
            if (m?.role === "assistant" && m.stopReason === "aborted")
                sawAbort = true;
            // Dock fix (owner ruling 2026-09-26): an injected steer marker's
            // message_end = the card is visible to the learner — flip the
            // job's bookkeeping now (the turn may keep teaching for minutes;
            // settleSteers re-runs the flip as a no-op idempotently).
            if (m?.role === "custom")
                noteSteerVisible(event.message);
        }
        if (event.type === "agent_end") {
            closeAll();
            settleWith();
        }
    };
    agent.subscribe(handle);
    void (async () => {
        try {
            await agent.continue();
        }
        catch (err) {
            // A loop-level failure (not a provider error — those ride the
            // stream as stopReason "error"): surface, close, persist. If the
            // agent already settled (agent_end reached before the throw),
            // the seam has run — never settle twice.
            if (settled)
                return;
            console.error("[turn] agent loop failed:", err);
            send({ type: "error", errorText: onError?.(err) ?? "An error occurred." });
            closeAll();
            settleWith();
        }
    })();
    return {
        subscribe() {
            let sub;
            const stream = new ReadableStream({
                start(controller) {
                    const encoder = new TextEncoder();
                    let closed = false;
                    sub = {
                        push(event) {
                            if (closed)
                                return;
                            try {
                                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
                            }
                            catch {
                                /* reader cancelled — stop emitting, keep running */
                                closed = true;
                            }
                        },
                        done() {
                            if (closed)
                                return;
                            closed = true;
                            try {
                                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                                controller.close();
                            }
                            catch {
                                /* already cancelled */
                            }
                        },
                    };
                    // Attach THEN replay — synchronous, so no event can fall
                    // between replay and live (single-threaded: the agent's
                    // handle() only runs after this stack returns). The compacted
                    // log replays settled events + the latest snapshot per
                    // in-flight message — the full content, once, never the chunk
                    // history (COMPACTION LAW).
                    subscribers.add(sub);
                    for (const event of log)
                        sub.push(event);
                    // A subscriber that attached after settle (the unregister
                    // race) still gets the full history + [DONE].
                    if (settled)
                        sub.done();
                },
                cancel() {
                    // THE OWNER RULING (2026-09-25): a view leaving NEVER kills
                    // the turn — only the explicit abort channel does. The turn
                    // runs on; the compacted log keeps the state for the next view.
                    if (sub)
                        subscribers.delete(sub);
                },
            });
            return stream;
        },
        abort() {
            if (settled)
                return;
            sawAbort = true;
            agent.abort();
        },
    };
}
/** The subscriber-shaped SSE response — the POST /api/chat response and
 * GET /api/chats/[id]/stream are BOTH this: same headers, same wire
 * dialect, one protocol for the client to consume. */
export function piTurnResponse(handle) {
    return new Response(handle.subscribe(), {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    });
}
//# sourceMappingURL=ui-stream.js.map