/**
 * Den extensions on the host.
 *
 * `<den>/extensions/<name>/index.js` holds both extensions the CLI ships on
 * sync (bundled repo extensions, built den extensions) and ones the owner put
 * there by hand. A sync must never delete the latter, so the names it ships
 * are recorded in `.managed.json` and only those are ever cleaned up.
 */
import fs from "node:fs/promises";
import path from "node:path";

export const MANAGED_EXTENSIONS_FILE = ".managed.json";

/** A single path segment: no separators, no dot-dirs. */
export function isSafeExtensionName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes("..");
}

export async function writeDenExtensions(
  denDir: string,
  extensionsMap: Record<string, string>,
): Promise<void> {
  const extDir = path.join(denDir, "extensions");
  const manifestPath = path.join(extDir, MANAGED_EXTENSIONS_FILE);
  await fs.mkdir(extDir, { recursive: true });

  let previous: string[] = [];
  try {
    const parsed = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
    if (Array.isArray(parsed)) previous = parsed.filter((n): n is string => typeof n === "string");
  } catch {
    // No manifest yet (first sync with it): nothing known to clean
  }

  const shipped = Object.keys(extensionsMap).filter(isSafeExtensionName);
  for (const name of previous) {
    if (!shipped.includes(name) && isSafeExtensionName(name)) {
      await fs.rm(path.join(extDir, name), { recursive: true, force: true });
    }
  }
  for (const name of shipped) {
    const extPath = path.join(extDir, name);
    await fs.mkdir(extPath, { recursive: true });
    await fs.writeFile(path.join(extPath, "index.js"), Buffer.from(extensionsMap[name]!, "base64"));
  }
  await fs.writeFile(manifestPath, JSON.stringify(shipped));
}
