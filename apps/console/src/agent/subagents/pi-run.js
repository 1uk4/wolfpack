import { Agent } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import { APP_IDENTITY, piEngineFor } from "../models.ts";
import { providerEventObserver } from "../provider-events.ts";
export function subagentEngine(role, override) {
    // BYOK (owner, 2026-09-22): no factory pins — the override is the only
    // real path (the runner injects settings-resolved engines); a missed
    // injection hits the honest thrower in models.ts instead of a guess.
    return override ?? piEngineFor(role);
}
export async function runSubagent(tools, opts) {
    const engine = subagentEngine(opts.role, opts.engine);
    let turns = 0;
    // Debug recorder (owner, 2026-10-04): raw provider events per job run.
    const providerEvents = opts.chatId ? providerEventObserver(opts.chatId, `job:${opts.role}`) : undefined;
    const agent = new Agent({
        identity: APP_IDENTITY,
        // One unsaved conversation per invocation, stable through every turn.
        sessionId: randomUUID(),
        initialState: {
            systemPrompt: opts.systemPrompt,
            model: engine.model,
            thinkingLevel: engine.level,
            tools,
            messages: opts.messages ?? [],
        },
        streamFn: engine.streamFn,
        ...(providerEvents ? { onProviderStreamEvent: providerEvents } : {}),
        // 0.87.1: shouldStopAfterTurn → finishTurn (same call point; "end"
        // exits before the steering poll, exactly the old boolean-true).
        finishTurn: (turn) => {
            turns++;
            return turns >= opts.maxTurns || opts.shouldStop?.(turn.message, turn.toolResults) === true
                ? { action: "end" }
                : undefined;
        },
    });
    const onAbort = () => agent.abort();
    opts.abortSignal?.addEventListener("abort", onAbort, { once: true });
    const before = opts.messages?.length ?? 0;
    let step = 0;
    let errorMessage;
    let aborted = false;
    try {
        agent.subscribe((event) => {
            switch (event.type) {
                case "message_end":
                    if (event.message.role === "assistant") {
                        const m = event.message;
                        if (m.stopReason === "aborted") {
                            // The call was cancelled — no completed step, no billed
                            // usage (the abort path asserts zero steps).
                            aborted = true;
                            break;
                        }
                        step++;
                        opts.onUsage?.(m.usage);
                        opts.onAssistantMessage?.(m, step);
                        if (m.stopReason === "error")
                            errorMessage = m.errorMessage;
                    }
                    break;
                case "tool_execution_start":
                    opts.onToolStart?.(event.toolName, event.args);
                    break;
            }
        });
        if (opts.prompt !== undefined)
            await agent.prompt({
                role: "user",
                content: opts.prompt,
                timestamp: Date.now(),
            });
        else
            await agent.continue();
    }
    finally {
        opts.abortSignal?.removeEventListener("abort", onAbort);
    }
    if (aborted || opts.abortSignal?.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
    }
    if (errorMessage !== undefined)
        throw new Error(errorMessage);
    // 0.87.1: drop the seeded leading SystemMessage (transcript rework —
    // see ui-stream's settleWith) before slicing past the input count, or
    // the seed displaces the slice and the last INPUT message leaks in.
    const newMessages = agent.state.messages
        .filter((m) => m.role !== "system")
        .slice(before);
    const assistants = newMessages.filter((m) => m.role === "assistant");
    const last = assistants[assistants.length - 1];
    const text = last
        ? last.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("")
        : "";
    return { newMessages, text };
}
//# sourceMappingURL=pi-run.js.map