import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadModelTable, MODELS_FILE_ENV, type ModelTable } from "@wolfpack/engine";

export interface WolfConfig {
  id?: string;
  name: string;
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
  // VPS layout: <wolf home>/{wolf.yaml, den/, agent/}
  const homeDir = join(wolfDen, "..");
  const configPath = join(homeDir, "wolf.yaml");
  const content = await readFile(configPath, "utf-8");
  const config = parseYaml(content) as WolfConfig;

  if (!config.name) {
    throw new Error("wolf.yaml must specify 'name'");
  }

  return config;
}

/**
 * Load the wolf's resolved model table: `models.json` next to wolf.yaml,
 * resolved on the user's machine and shipped by `wolfpack sync`. The VPS
 * never resolves models itself. Points WOLFPACK_MODELS_FILE at the file so
 * extensions loaded afterwards (memory) read the same table.
 */
export function loadWolfModels(config: WolfConfig): ModelTable {
  const wolfDen = process.env.WOLF_DEN;
  if (!wolfDen) {
    throw new Error("WOLF_DEN environment variable is required");
  }
  const file = join(wolfDen, "..", "models.json");
  if (!existsSync(file)) {
    throw new Error(`no models.json at ${file} — run \`wolfpack sync ${config.name}\``);
  }
  process.env[MODELS_FILE_ENV] = file;
  return loadModelTable({ file }).table;
}

// Extension loading moved to extensions.ts
