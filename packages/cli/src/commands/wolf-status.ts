/**
 * wolfpack status <wolf> [--host <host>]
 *
 * Works for local and remote wolves via WolfBackend.
 */

import { resolveBackend } from "../backend/index.js";
import { c } from "../render.js";

export async function wolfStatus(
  nameOrId: string,
  opts: { host?: string },
): Promise<void> {
  try {
    const backend = resolveBackend(opts.host);
    const s = await backend.status(nameOrId);
    const marker = s.active ? c.green("🟢") : c.red("🔴");

    console.log(`${marker} ${c.bold(s.name)} (${s.id})  ${c.dim(`@${s.host}`)}`);
    console.log(`  Runtime:  ${s.runtime}`);
    console.log(`  State:    ${s.serviceState}`);
    if (s.since) console.log(`  Since:    ${s.since}`);

    if (s.memory) {
      const m = s.memory;
      const age = Math.round((Date.now() - m.updatedAt) / 1000);
      console.log(
        `  Memory:   ${m.enabled ? c.green("on") : c.dim("off")} · ${m.observations} obs · ${m.poolTokens}/${m.consolidateAt} tok · $${m.totalCostUsd.toFixed(3)} ${c.dim(`(${age}s ago)`)}`,
      );
    }
    if (s.error) console.log(`  Error:    ${c.red(s.error)}`);
  } catch (err) {
    console.error(c.red(`Failed: ${err instanceof Error ? err.message : err}`));
    process.exit(1);
  }
}
