import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverWolves } from "@wolfpack/engine";

export const FAKE_WOLF = join(dirname(fileURLToPath(import.meta.url)), "fake-wolf.mjs");
export const FAKE_COMMAND = [process.execPath, FAKE_WOLF];

/** A temp wolves dir with `<name>/wolf.yaml` per wolf; returns the root and the discovered configs. */
export function makeWolves(...names: string[]) {
  const root = mkdtempSync(join(tmpdir(), "workerd-"));
  for (const n of names) {
    mkdirSync(join(root, n), { recursive: true });
    writeFileSync(join(root, n, "wolf.yaml"), `name: ${n}\n`);
  }
  const found = discoverWolves(root);
  if (found.errors.length) throw new Error(found.errors.map((e) => e.message).join("; "));
  return { root, wolves: found.wolves.map((l) => l.config) };
}

export async function until(cond: () => boolean, timeoutMs = 10_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
