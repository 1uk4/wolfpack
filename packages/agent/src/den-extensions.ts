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

const SNAPSHOT_FILE = "snapshot.json";

async function readManaged(extDir: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(extDir, MANAGED_EXTENSIONS_FILE), "utf-8"));
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string" && isSafeExtensionName(n)) : [];
  } catch {
    return [];
  }
}

/**
 * Save what writeDenExtensions is about to replace or remove (the previously managed extensions plus any same-named
 * ones in the new set) to `backupDir`, so a rolled-back sync can put the extensions back with the old harness.
 * Owner extensions that a sync does not ship are never touched, so they are not saved.
 */
export async function snapshotDenExtensions(denDir: string, backupDir: string, extensionsMap: Record<string, string>): Promise<void> {
  const extDir = path.join(denDir, "extensions");
  const managed = await readManaged(extDir);
  const touched = [...new Set([...managed, ...Object.keys(extensionsMap).filter(isSafeExtensionName)])];
  await fs.rm(backupDir, { recursive: true, force: true });
  await fs.mkdir(backupDir, { recursive: true });
  const present: string[] = [];
  for (const name of touched) {
    const src = path.join(extDir, name);
    try {
      await fs.cp(src, path.join(backupDir, name), { recursive: true });
      present.push(name);
    } catch {
      // not on disk: restoring removes whatever the new sync puts there
    }
  }
  await fs.writeFile(path.join(backupDir, SNAPSHOT_FILE), JSON.stringify({ managed, touched, present }));
}

/** Undo the last writeDenExtensions from its snapshot. Returns false when there is no snapshot (nothing changed). */
export async function restoreDenExtensions(denDir: string, backupDir: string): Promise<boolean> {
  let snap: { managed: string[]; touched: string[]; present: string[] };
  try {
    snap = JSON.parse(await fs.readFile(path.join(backupDir, SNAPSHOT_FILE), "utf-8"));
  } catch {
    return false;
  }
  const extDir = path.join(denDir, "extensions");
  await fs.mkdir(extDir, { recursive: true });
  for (const name of snap.touched.filter(isSafeExtensionName)) {
    await fs.rm(path.join(extDir, name), { recursive: true, force: true });
    if (snap.present.includes(name)) await fs.cp(path.join(backupDir, name), path.join(extDir, name), { recursive: true });
  }
  await fs.writeFile(path.join(extDir, MANAGED_EXTENSIONS_FILE), JSON.stringify(snap.managed));
  return true;
}
