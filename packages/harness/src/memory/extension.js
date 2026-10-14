/**
 * Wolfpack Memory Extension for Pi Durable.
 *
 * Combines:
 * - Observer hook (afterResponse → extract observations → write to pool)
 * - Den injection section (topic list for discovery)
 * - KB access section (domain list for discovery)
 * - Consolidation tool (manual: memory_consolidate)
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, hook, section, GenerationTask } from "@earendil-works/pi-durable";
import { observe, renderDenContext, renderKbAccess } from "@wolfpack/memory";
import { createEngine } from "@wolfpack/engine";
import { consolidatePool } from "./consolidation.js";
// Root conversation ID in pi-durable
const ROOT_CONVERSATION_ID = 1;
/**
 * Format an assistant message for observation extraction.
 */
function formatMessage(message) {
    const parts = [];
    for (const block of message.content) {
        if (block.type === "text") {
            parts.push(`[assistant] ${block.text}`);
        }
        else if (block.type === "toolCall") {
            parts.push(`[tool_call] ${block.name}(${JSON.stringify(block.arguments).slice(0, 200)})`);
        }
        else if (block.type === "thinking") {
            parts.push(`[thinking] ${block.thinking.slice(0, 500)}`);
        }
    }
    return parts.join("\n");
}
/**
 * Write observations to the pool file.
 */
async function writeToPool(wolfDen, observations) {
    if (observations.length === 0)
        return;
    const poolDir = join(wolfDen, ".memory", "pool");
    await mkdir(poolDir, { recursive: true });
    const poolFile = join(poolDir, "observations.jsonl");
    const timestamp = new Date().toISOString();
    const lines = observations.map(obs => JSON.stringify({ ...obs, recordedAt: timestamp }) + "\n");
    await appendFile(poolFile, lines.join(""));
}
/**
 * Create the unified wolfpack memory extension.
 */
export function createMemoryExtension(config) {
    const { wolfDen, wolfName, kbBase, fastModel = "claude-haiku-4-5", model = "claude-sonnet-4-6", provider = "anthropic", minTextLength = 100, } = config;
    // Lazy-init engine on first observation
    let engine = null;
    function getEngine() {
        if (!engine) {
            engine = createEngine({
                provider,
                defaultModel: model,
                steps: {
                    classify: { model: fastModel },
                    consolidate: { model, maxTokens: 16000 },
                },
            });
        }
        return engine;
    }
    // Pool stats helper
    async function getPoolStats() {
        const poolFile = join(wolfDen, ".memory", "pool", "observations.jsonl");
        if (!existsSync(poolFile))
            return { count: 0, tokens: 0 };
        try {
            const content = await readFile(poolFile, "utf-8");
            const lines = content.split("\n").filter((l) => l.trim());
            const tokens = Math.ceil(content.length / 4);
            return { count: lines.length, tokens };
        }
        catch {
            return { count: 0, tokens: 0 };
        }
    }
    return defineExtension({
        name: "wolfpack-memory",
        tools: [
            // Manual consolidation tool
            defineTool({
                name: "memory_consolidate",
                description: "Consolidate observation pool into persistent memory topics. Use when you have important context to preserve, or when the pool is getting large.",
                parameters: Type.Object({
                    reason: Type.Optional(Type.String({ description: "Why you're consolidating (for logging)" })),
                }),
                async execute(args) {
                    try {
                        const stats = await getPoolStats();
                        if (stats.count === 0) {
                            return {
                                content: [{ type: "text", text: "Nothing to consolidate — pool is empty." }],
                                isError: false,
                            };
                        }
                        const result = await consolidatePool({
                            wolfDen,
                            wolfName,
                            model,
                            provider,
                            kbRoots: config.kbRoots,
                            defaultDomain: config.defaultDomain,
                            onProgress: (msg) => console.log(`[memory] ${msg}`),
                        });
                        return {
                            content: [{
                                    type: "text",
                                    text: `Consolidated ${result.observationsProcessed} observations: ${result.topicsCreated} created, ${result.topicsMerged} updated, ${result.topicsSkipped} skipped.`,
                                }],
                            isError: false,
                        };
                    }
                    catch (err) {
                        return {
                            content: [{
                                    type: "text",
                                    text: `Consolidation failed: ${err instanceof Error ? err.message : String(err)}`,
                                }],
                            isError: true,
                        };
                    }
                },
            }),
        ],
        sections: [
            // Den topics section — lists topics for discovery
            section("wolf_memory", () => {
                const content = renderDenContext(wolfDen, wolfName);
                return content ?? undefined;
            }),
            // KB access section — lists subscribed domains for discovery
            section("kb_access", () => {
                const content = renderKbAccess(kbBase, config.subscribedDomains ?? []);
                return content ?? undefined;
            }),
        ],
        hooks: [
            hook(GenerationTask, {
                afterResponse: (message, api) => {
                    // Only observe root conversation — subagents are ephemeral
                    if (Number(api.conversationId) !== ROOT_CONVERSATION_ID) {
                        return;
                    }
                    // Fire-and-forget: don't await, don't block
                    (async () => {
                        try {
                            const text = formatMessage(message);
                            // Skip short messages
                            if (text.length < minTextLength) {
                                return;
                            }
                            const eng = getEngine();
                            const result = await observe({
                                engine: eng,
                                chunkText: text,
                                mode: "conversation",
                            });
                            if (result.observations.length > 0) {
                                await writeToPool(wolfDen, result.observations);
                                // Check threshold for auto-consolidation
                                if (config.consolidationThreshold) {
                                    const stats = await getPoolStats();
                                    if (stats.tokens >= config.consolidationThreshold) {
                                        console.log(`[memory] Threshold reached (${stats.tokens} >= ${config.consolidationThreshold}), consolidating...`);
                                        try {
                                            const consResult = await consolidatePool({
                                                wolfDen,
                                                wolfName,
                                                model,
                                                provider,
                                                kbRoots: config.kbRoots,
                                                defaultDomain: config.defaultDomain,
                                                onProgress: (msg) => console.log(`[memory] ${msg}`),
                                            });
                                            console.log(`[memory] Auto-consolidated: ${consResult.topicsCreated} created, ${consResult.topicsMerged} updated`);
                                        }
                                        catch (consErr) {
                                            console.error("[memory] Auto-consolidation failed:", consErr instanceof Error ? consErr.message : consErr);
                                        }
                                    }
                                }
                            }
                        }
                        catch (err) {
                            // Log but don't crash — memory is background work
                            console.error("[memory] observation error:", err instanceof Error ? err.message : err);
                        }
                    })();
                },
            }),
        ],
    });
}
//# sourceMappingURL=extension.js.map