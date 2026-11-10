import { randomBytes } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";

/**
 * Replace a file's contents in one step: write `<path>.<pid>.<random>.tmp` beside it, then rename over it.
 * A concurrent reader sees the old or the new file, never an empty or partial one.
 */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
