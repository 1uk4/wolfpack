/**
 * CLI side of model resolution: resolve a wolf's model table from the pack
 * config (~/.wolfpack/config.yaml `models:`) and the wolf's own config.
 * The resolver itself lives in @wolfpack/engine (models.ts); this only finds
 * the inputs — a local wolf's wolf.yaml, or a VPS wolf's config as returned
 * by its agent — and fixes the location.
 */
import path from "node:path";
import crypto from "node:crypto";
import {
  modelTableFingerprint,
  readWolfModels,
  resolveModelTable,
  type ModelTable,
  type WolfModels,
} from "@wolfpack/engine";
import { type CliConfig, localWolfDir } from "./config.js";

/** File name of the resolved table, next to wolf.yaml (local wolf dir and VPS bundle). */
export const MODELS_FILE_NAME = "models.json";

/** Resolve a local wolf's table: pack `models:` < <wolfDir>/wolf.yaml. */
export function resolveLocalWolfModels(config: CliConfig, name: string): ModelTable {
  const wolfYaml = path.join(localWolfDir(config, name), "wolf.yaml");
  return resolveModelTable({ pack: config.models, wolf: readWolfModels(wolfYaml), location: "local" });
}

/** Resolve a VPS wolf's table from its remote config (agent API `config`). */
export function resolveRemoteWolfModels(
  config: CliConfig,
  remoteConfig: { transport?: unknown; models?: unknown } | undefined,
): ModelTable {
  const wolf: WolfModels = {
    transport: typeof remoteConfig?.transport === "string" ? remoteConfig.transport : undefined,
    models: (remoteConfig?.models ?? undefined) as WolfModels["models"],
  };
  return resolveModelTable({ pack: config.models, wolf, location: "vps" });
}

/** sha256 of the table's canonical form — recorded in the bundle manifest for drift. */
export function modelTableHash(table: ModelTable): string {
  return crypto.createHash("sha256").update(modelTableFingerprint(table)).digest("hex");
}
