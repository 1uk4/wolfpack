import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
// TODO: Claude Agent SDK provider for MAX/Pro subscription support
// Requires pi-claude-bridge to export a pi-ai provider, or implementing
// the full pi-ai AssistantMessageEventStream protocol (~500-1000 lines).
// For now, use provider: "anthropic" with ANTHROPIC_API_KEY.
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { loadWolfConfig } from "./config.js";
import { loadExtensions as loadUnifiedExtensions } from "./loader.js";
import { createWolfIdentityExtension } from "./extensions/wolf-identity.js";
import { createTelegramClient, createTelegramSharedState } from "./telegram/index.js";
import { consolidatePool, getPoolStats } from "./memory/consolidation.js";
import { initSweepManager } from "./sweep-worker.js";
export { loadWolfConfig };
export { createWolfIdentityExtension } from "./extensions/wolf-identity.js";
export { createTelegramClient } from "./telegram/index.js";
// Legacy exports for backward compatibility
export { loadExtensions, listBundledExtensions } from "./extensions.js";
export { createMemoryExtension } from "./memory/index.js";
// Unified extension API
export { defineExtension, defineTool, section, supportsRuntime, Type, } from "./extension-api.js";
export { adaptToDurable } from "./adapters/durable.js";
export { loadExtensions as loadUnifiedExtensions } from "./loader.js";
/** Parse interval string (e.g., "4h", "30m", "1d") to milliseconds */
function parseInterval(interval) {
    const match = interval.match(/^(\d+)(s|m|h|d)$/);
    if (!match)
        return 4 * 60 * 60 * 1000; // default 4h
    const value = parseInt(match[1], 10);
    const unit = match[2];
    switch (unit) {
        case "s": return value * 1000;
        case "m": return value * 60 * 1000;
        case "h": return value * 60 * 60 * 1000;
        case "d": return value * 24 * 60 * 60 * 1000;
        default: return 4 * 60 * 60 * 1000;
    }
}
export async function createWolfHarness() {
    const context = BACKGROUND_CONTEXT;
    const config = await loadWolfConfig();
    const wolfDen = process.env.WOLF_DEN;
    // Provider setup (anthropic requires ANTHROPIC_API_KEY)
    console.log(`[harness] Provider: ${config.provider ?? 'anthropic'}`);
    console.log(`[harness] API key set: ${!!process.env.ANTHROPIC_API_KEY}`);
    const models = createModels();
    if (config.provider === "openai") {
        models.setProvider(openaiProvider());
    }
    else {
        models.setProvider(anthropicProvider());
    }
    // Registry with CodingTools + wolf identity + wolf extensions
    const registry = createRegistry();
    registry.install(CodingTools);
    // Wolf identity extension — provides AGENTS.md, CLAUDE.md sections
    const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(wolfDen, "..", "agent");
    registry.install(createWolfIdentityExtension({ config, wolfDen, agentDir }));
    // Memory config for timer-based consolidation
    const memoryEnabled = config.memory?.enabled ?? config.extensions?.includes("memory") ?? false;
    const consolidationConfig = config.memory?.consolidation;
    const consolidationTrigger = consolidationConfig?.trigger ?? "threshold";
    // KB roots (requires KB_OPS)
    const kbOps = process.env.KB_OPS;
    const kbBase = process.env.KB_BASE;
    const kbRoots = kbOps
        ? {
            kbBase: kbBase ?? "",
            opsRoot: kbOps,
            denLocal: join(wolfDen, "kb"),
        }
        : undefined;
    const defaultDomain = config.domains?.[0] ?? process.env.WOLFPACK_DOMAIN ?? "wolfpack";
    // Initialize sweep manager if librarian mode is enabled
    const librarianConfig = config.memory?.librarian;
    const isLibrarian = librarianConfig === true || (typeof librarianConfig === "object" && librarianConfig.enabled);
    let sweepManager;
    if (isLibrarian && kbRoots) {
        sweepManager = initSweepManager({
            kbBase: kbRoots.kbBase,
            kbOps: kbRoots.opsRoot,
            denLocal: kbRoots.denLocal,
            embedUrl: process.env.WOLFPACK_EMBED_URL,
            embedModel: process.env.WOLFPACK_EMBED_MODEL,
            provider: config.provider === "openai" ? "anthropic" : config.provider,
            model: config.memory?.model ?? config.model,
            fastModel: config.memory?.fastModel,
        });
        console.log("[librarian] Sweep manager initialized");
    }
    // Create shared telegram state if telegram is configured
    const telegramState = config.telegram
        ? createTelegramSharedState()
        : undefined;
    // Load all extensions via unified loader
    // Pass shared state via context for proper coordination
    const loadResult = await loadUnifiedExtensions(config.extensions ?? [], {
        wolfDen,
        wolfName: config.name,
        domains: config.domains ?? [],
        runtime: "pi-durable",
        wolfConfig: config,
        telegram: telegramState,
        sweep: sweepManager,
    });
    // Install loaded extensions
    for (const ext of loadResult.extensions) {
        registry.install(ext);
        console.log(`[harness] Extension ${ext.name} loaded`);
    }
    // Log load results
    if (loadResult.extensions.length > 0) {
        console.log(`[harness] Loaded ${loadResult.extensions.length} extension(s)`);
    }
    if (loadResult.failed.length > 0) {
        for (const f of loadResult.failed) {
            console.warn(`[harness] Extension ${f.name}: ${f.error}`);
        }
    }
    if (loadResult.unsupported.length > 0) {
        console.log(`[harness] Skipped (no pi-durable support): ${loadResult.unsupported.join(", ")}`);
    }
    // SQLite storage
    const storagePath = join(wolfDen, config.harness?.storage ?? "session.sqlite");
    const storage = await openNodeSqliteStorage(storagePath);
    // Harness with compaction settings
    const harness = await Harness.open(storage, {
        models,
        registry,
        env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? wolfDen }),
        settings: {
            compaction: config.harness?.compaction ?? {
                reserveTokens: 16384,
                backgroundTokens: 32768,
            },
        },
    }, context);
    // Root conversation with wolf identity
    // Model ID should be just the model name, provider is separate
    const providerName = config.provider ?? "anthropic";
    // Extract just the model name if it includes provider prefix
    const modelName = config.model.includes("/")
        ? config.model.split("/").pop()
        : config.model;
    console.log(`[harness] Creating root: provider=${providerName}, model=${modelName}`);
    await harness.root(context, {
        agent: {
            model: { provider: providerName, modelId: modelName },
            cwd: wolfDen,
        },
    });
    // Resume interrupted work
    harness.resume();
    console.log(`Wolf harness started: ${config.name} (${config.model})`);
    console.log(`Storage: ${storagePath}`);
    // Set up consolidation timer if configured (timer or hybrid mode)
    let consolidationTimer;
    if (memoryEnabled && (consolidationTrigger === "timer" || consolidationTrigger === "hybrid")) {
        const intervalStr = consolidationConfig?.interval ?? "4h";
        const intervalMs = parseInterval(intervalStr);
        console.log(`[memory] Consolidation timer: every ${intervalStr}`);
        consolidationTimer = setInterval(async () => {
            try {
                const stats = await getPoolStats(wolfDen);
                if (stats.count === 0)
                    return;
                console.log(`[memory] Timer-triggered consolidation (${stats.count} observations)`);
                const result = await consolidatePool({
                    wolfDen,
                    wolfName: config.name,
                    model: config.memory?.model ?? config.model,
                    provider: config.provider === "openai" ? "anthropic" : config.provider,
                    kbRoots,
                    defaultDomain,
                    onProgress: (msg) => console.log(`[memory] ${msg}`),
                });
                console.log(`[memory] Consolidated: ${result.topicsCreated} created, ${result.topicsMerged} updated`);
            }
            catch (err) {
                console.error("[memory] Timer consolidation failed:", err instanceof Error ? err.message : err);
            }
        }, intervalMs);
    }
    // Set up sweep timer if librarian mode with interval
    let sweepTimer;
    const sweepInterval = typeof librarianConfig === "object" ? librarianConfig.sweepInterval : undefined;
    if (sweepManager && sweepInterval) {
        const sweepMs = parseInterval(sweepInterval);
        console.log(`[librarian] Sweep timer: every ${sweepInterval}`);
        sweepTimer = setInterval(async () => {
            if (sweepManager.isRunning()) {
                console.log(`[librarian] Sweep already running, skipping timer trigger`);
                return;
            }
            console.log(`[librarian] Timer-triggered sweep`);
            const result = await sweepManager.start();
            if (!result.started) {
                console.log(`[librarian] Sweep not started: ${result.reason}`);
            }
        }, sweepMs);
    }
    // Start Telegram client if configured
    let telegram;
    if (config.telegram) {
        const tokenEnv = config.telegram.tokenEnv ?? "TELEGRAM_BOT_TOKEN";
        const botToken = process.env[tokenEnv];
        if (botToken) {
            telegram = await createTelegramClient(harness, {
                botToken,
                ownerId: config.telegram.ownerId,
                sharedState: telegramState,
            });
            await telegram.start();
        }
        else {
            console.warn(`[telegram] ${tokenEnv} not set, skipping Telegram`);
        }
    }
    return {
        harness,
        config,
        telegram,
        consolidationTimer,
        sweepTimer,
        close: async () => {
            console.log("Closing harness...");
            if (consolidationTimer)
                clearInterval(consolidationTimer);
            if (sweepTimer)
                clearInterval(sweepTimer);
            if (telegram)
                await telegram.stop();
            await harness.close(context);
        },
    };
}
//# sourceMappingURL=index.js.map