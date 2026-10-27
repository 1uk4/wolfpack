/** Official engine surface. Import from here; pi-durable types stay inside this directory. */
export {
  openWolfEngine,
  EngineBusyError,
  type WolfEngine,
  type WolfEngineOptions,
  type EngineConversation,
  type EngineWatch,
  type ConfigureOptions,
  type SubmitOptions,
  type SubmitResult,
  type WhenBusy,
  type ThinkingLevel,
} from "./engine.js";
export {
  createEventMapper,
  mapEngineEvents,
  stampEvent,
  type EngineEvent,
  type EngineSnapshot,
  type EventMapper,
  type MappedEvent,
  type ResyncDraft,
  type StampContext,
  type ThreadEventDraft,
} from "./events.js";
export { backupSessionStore, findBackup, type BackupOptions, type BackupResult } from "./backup.js";
export { engineVersion } from "./version.js";
export { resolveToolNames, TOOL_REGISTRY_NAMES, type ResolvedTools } from "./tools.js";
export { createConversationReader, conversationReaderFor, type ConversationReader } from "./conversation-reader.js";
/** @internal the background Context the engine calls pi-durable with; for tests driving `WolfEngine.harness`. */
export { BACKGROUND_CONTEXT as ENGINE_CONTEXT } from "@earendil-works/chord/context";
export { objectsExtension, objectFromCall, type ObjectCall } from "./objects.js";
