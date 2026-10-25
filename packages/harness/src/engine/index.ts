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
