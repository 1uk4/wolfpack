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

/** The wolf.yaml `memory:` block as the loader hands it over: every MemoryConfig field, plus the tasks settings. */
export interface WolfpackMemoryConfig extends MemoryConfig {
  tasks?: TasksConfig;
}

// ─── Combined Extension Factory ────────────────────────────────────────────

export default function createWolfpackMemoryExtension(
  config: WolfpackMemoryConfig,
  context: ExtensionContext
): ReturnType<typeof defineExtension> {
  // Build individual extensions
  // Forward every MemoryConfig field: a hand-picked copy silently drops whatever gets added later.
  const { tasks, ...memoryConfig } = config;
  
  const tasksConfig: TasksConfig = tasks ?? {};
  
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
