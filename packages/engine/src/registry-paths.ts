/**
 * Where the CLI's own control-plane files live (`~/.wolfpack` by default). ONE definition, shared by the CLI writer
 * (`wolfpack domain` -> domains.yaml) and the kb readers, so they can never point at different registries.
 * `WOLFPACK_REGISTRY_DIR` relocates the directory (tests, sandboxes).
 */
import { homedir } from "node:os";
import { join } from "node:path";

export function wolfpackRegistryDir(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.WOLFPACK_REGISTRY_DIR?.trim();
  return v ? v : join(homedir(), ".wolfpack");
}

/** `<registry dir>/domains.yaml`: the declared-domain registry the CLI owns. */
export function cliDomainsFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(wolfpackRegistryDir(env), "domains.yaml");
}
