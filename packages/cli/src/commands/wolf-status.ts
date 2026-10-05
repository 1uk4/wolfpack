/**
 * wolfpack status <wolf> [--host <host>]
 *
 * Works for local and remote wolves via WolfBackend.
 */

import { resolveBackend } from "../backend/index.js";
import { stampExtension } from "../bundle.js";
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
    if (s.bundle && s.bundle.length) {
      console.log(`  Extensions:`);
      let drift = 0;
      for (const ext of s.bundle) {
        const current = await stampExtension(ext.key);
        let tag: string;
        if (!current) {
          tag = c.dim("(not in repo)");
        } else if (current.hash === ext.hash) {
          tag = c.green("up to date");
        } else {
          drift++;
          const bump = current.version !== ext.version ? ` → ${current.version}` : " (content changed)";
          tag = c.yellow(`out of date${bump}`);
        }
        console.log(`    ${ext.key}@${ext.version}  ${tag}`);
      }
      if (drift > 0) {
        console.log(c.yellow(`  ${drift} extension(s) out of date — run: wolfpack sync ${s.name}`));
      }
    }
    if (s.error) console.log(`  Error:    ${c.red(s.error)}`);
  } catch (err) {
    console.error(c.red(`Failed: ${err instanceof Error ? err.message : err}`));
    process.exit(1);
  }
}
