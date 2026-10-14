/**
 * Wolfpack Memory Extension — Pi-Durable Combined Entry Point
 * 
 * Combines memory (observation/consolidation) and tasks (work system) into
 * a single extension for pi-durable runtime.
 */
import {
  defineExtension,
  type ExtensionContext,
} from "@wolfpack/harness/extension";
import createMemoryExtension, { type MemoryConfig } from "./unified.js";
import createTasksExtension, { type TasksConfig } from "./unified-tasks.js";

// ─── Combined Config ───────────────────────────────────────────────────────

export interface WolfpackMemoryConfig {
  // Memory settings
  enabled?: boolean;
  fastModel?: string;
  model?: string;
  provider?: "anthropic" | "claude-agent-sdk";
  minTextLength?: number;
  consolidation?: {
    trigger?: "threshold" | "timer" | "hybrid" | "manual";
    threshold?: number;
    interval?: string;
  };
  /** Librarian mode - enables KB sweep and inbox tools */
  librarian?: boolean;
  // Task settings
  tasks?: TasksConfig;
}

// ─── Combined Extension Factory ────────────────────────────────────────────

export default function createWolfpackMemoryExtension(
  config: WolfpackMemoryConfig,
  context: ExtensionContext
): ReturnType<typeof defineExtension> {
  // Build individual extensions
  const memoryConfig: MemoryConfig = {
    enabled: config.enabled,
    fastModel: config.fastModel,
    model: config.model,
    provider: config.provider,
    minTextLength: config.minTextLength,
    consolidation: config.consolidation,
    librarian: config.librarian,
  };
  
  const tasksConfig: TasksConfig = config.tasks ?? {};
  
  const memoryExt = createMemoryExtension(memoryConfig, context);
  const tasksExt = createTasksExtension(tasksConfig, context);

  // Combine into single extension
  return defineExtension({
    name: "wolfpack-memory",
    runtimes: ["pi-durable"],

    tools: [
      ...(memoryExt.tools ?? []),
      ...(tasksExt.tools ?? []),
    ],

    sections: [
      ...(memoryExt.sections ?? []),
      ...(tasksExt.sections ?? []),
    ],

    hooks: memoryExt.hooks, // Only memory has hooks (afterResponse)
  });
}
