import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

// Re-export extension loader
export { loadExtensions, listBundledExtensions } from "./extensions.js";

export interface WolfConfig {
  id?: string;
  name: string;
  model: string;
  provider?: "anthropic" | "openai";
  role?: string;
  specialty?: string;
  domains?: string[];
  extensions?: string[];
  telegram?: {
    tokenEnv?: string;  // env var name for bot token (default: TELEGRAM_BOT_TOKEN)
    ownerId: number;    // allowed user id
  };
  memory?: {
    enabled?: boolean;           // default: true if extensions includes 'memory'
    fastModel?: string;          // for observations (default: claude-haiku-4-5)
    model?: string;              // for consolidation (default: claude-sonnet-4-6)
    consolidation?: {
      trigger?: "timer" | "threshold" | "hybrid" | "manual";  // default: hybrid
      interval?: string;         // e.g. "24h" - pi-durable only
      threshold?: number;        // tokens (default: 15000)
    };
    /** Librarian mode - enables KB inbox tools and sweep */
    librarian?: boolean;
    /** Sweep interval (e.g., "15m", "1h") - auto-triggers sweep on timer */
    sweepInterval?: string;
  };
  harness?: {
    storage?: string;
    compaction?: {
      reserveTokens?: number;
      backgroundTokens?: number;
    };
  };
}

export async function loadWolfConfig(): Promise<WolfConfig> {
  const wolfDen = process.env.WOLF_DEN;
  if (!wolfDen) {
    throw new Error("WOLF_DEN environment variable is required");
  }

  // wolf.yaml is in the home directory (parent of den), not in den itself
  // VPS layout: /home/wolf-<id>/{wolf.yaml, den/, agent/}
  const homeDir = join(wolfDen, "..");
  const configPath = join(homeDir, "wolf.yaml");
  const content = await readFile(configPath, "utf-8");
  const config = parseYaml(content) as WolfConfig;

  if (!config.name) {
    throw new Error("wolf.yaml must specify 'name'");
  }
  if (!config.model) {
    throw new Error("wolf.yaml must specify 'model'");
  }

  return config;
}

// Extension loading moved to extensions.ts
