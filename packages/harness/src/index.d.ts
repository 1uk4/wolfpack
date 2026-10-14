import { Harness } from "@earendil-works/pi-durable";
import { loadWolfConfig, type WolfConfig } from "./config.js";
import { type TelegramClient } from "./telegram/index.js";
export { loadWolfConfig, type WolfConfig };
export { createWolfIdentityExtension } from "./extensions/wolf-identity.js";
export { createTelegramClient, type TelegramClient } from "./telegram/index.js";
export { loadExtensions, listBundledExtensions } from "./extensions.js";
export { createMemoryExtension, type MemoryExtensionConfig } from "./memory/index.js";
export { defineExtension, defineTool, section, supportsRuntime, Type, type Extension, type ExtensionFactory, type ExtensionContext, type Tool, type Section, type Hooks, type Runtime, type ToolContext, type ToolResult, type SectionContext, type HookContext, type AssistantMessage, } from "./extension-api.js";
export { adaptToDurable } from "./adapters/durable.js";
export { loadExtensions as loadUnifiedExtensions, type LoadResult } from "./loader.js";
export interface HarnessInstance {
    harness: Harness;
    config: WolfConfig;
    telegram?: TelegramClient;
    consolidationTimer?: ReturnType<typeof setInterval>;
    sweepTimer?: ReturnType<typeof setInterval>;
    close: () => Promise<void>;
}
export declare function createWolfHarness(): Promise<HarnessInstance>;
//# sourceMappingURL=index.d.ts.map