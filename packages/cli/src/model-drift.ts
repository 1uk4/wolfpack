/**
 * Model-table drift for deployed (VPS) wolves. A pi-durable bundle ships the
 * table resolved at sync time and records its hash in the bundle manifest;
 * the wolf is stale when the table the CLI would resolve now differs.
 */
import { ModelConfigError } from "@wolfpack/engine";
import type { CliConfig } from "./config.js";
import { modelTableHash, resolveRemoteWolfModels } from "./models.js";

export interface DeployedModels {
  /** The remote wolf.yaml's model keys. */
  config?: { transport?: unknown; models?: unknown };
  /** modelTableHash recorded in the deployed bundle manifest. */
  deployedHash?: string;
}

export interface ModelDrift {
  stale: boolean;
  /** Why it's stale (mentions "models"); undefined when current. */
  reason?: string;
  /** Hash of the table the CLI resolves now (undefined if config is broken). */
  currentHash?: string;
}

/** Compare the table resolved now with the one deployed. Pure (no I/O). */
export function checkModelDrift(config: Pick<CliConfig, "models">, deployed: DeployedModels): ModelDrift {
  let currentHash: string;
  try {
    currentHash = modelTableHash(resolveRemoteWolfModels(config as CliConfig, deployed.config));
  } catch (err) {
    if (err instanceof ModelConfigError) {
      return { stale: true, reason: `models: can't resolve (${err.message})` };
    }
    throw err;
  }
  if (!deployed.deployedHash) {
    return { stale: true, reason: "models: no model table deployed", currentHash };
  }
  if (deployed.deployedHash !== currentHash) {
    return { stale: true, reason: "models: resolved table changed since last sync", currentHash };
  }
  return { stale: false, currentHash };
}
