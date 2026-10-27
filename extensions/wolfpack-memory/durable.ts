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
import createCrawlExtension from "./unified-crawl.js";
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
  const crawlExt = createCrawlExtension({ defaultDomain: memoryConfig.defaultDomain }, context);

  // Combine into single extension
  return defineExtension({
    name: "wolfpack-memory",
    runtimes: ["pi-durable"],

    tools: [
      ...(memoryExt.tools ?? []),
      ...(tasksExt.tools ?? []),
      ...(crawlExt.tools ?? []),
    ],

    sections: [
      ...(memoryExt.sections ?? []),
      ...(tasksExt.sections ?? []),
    ],

    hooks: memoryExt.hooks, // Only memory has hooks (afterResponse)

    // Only the crawl runs' teardown is forwarded (aborts in-flight crawl runs); the memory extension's own stop is not
    // wired through this combiner today and is left as it was.
    lifecycle: crawlExt.lifecycle,
  });
}
