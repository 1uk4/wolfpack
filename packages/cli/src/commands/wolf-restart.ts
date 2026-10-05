/**
 * wolfpack restart <wolf> [--host <host>]
 *
 * Remote wolves restart via the agent. Local wolves are user-managed (Herdr)
 * and the LocalBackend reports that clearly.
 */

import { resolveBackend } from "../backend/index.js";
import { c } from "../render.js";

export async function wolfRestart(
  nameOrId: string,
  opts: { host?: string },
): Promise<void> {
  try {
    const backend = resolveBackend(opts.host);
    console.log(`Restarting ${nameOrId} @${backend.host}...`);
    await backend.restart(nameOrId);
    console.log(c.green(`✓ ${nameOrId} restarted`));
  } catch (err) {
    console.error(c.red(`${err instanceof Error ? err.message : err}`));
    process.exit(1);
  }
}
