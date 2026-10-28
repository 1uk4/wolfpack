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

const isEnoent = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";

/** Previously managed names; no manifest (ENOENT) means none. A manifest that cannot be read or parsed is an error. */
async function readManaged(extDir: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(extDir, MANAGED_EXTENSIONS_FILE), "utf-8");
  } catch (e) {
    if (isEnoent(e)) return [];
    throw e;
  }
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string" && isSafeExtensionName(n)) : [];
}

/**
 * Save what writeDenExtensions is about to replace or remove (the previously managed extensions plus any same-named
 * ones in the new set) to `backupDir`, so a rolled-back sync can put the extensions back with the old harness.
 * Owner extensions that a sync does not ship are never touched, so they are not saved.
 * Only ENOENT means "not on disk"; any other error is rethrown so the sync fails before anything is replaced.
 */
export async function snapshotDenExtensions(denDir: string, backupDir: string, extensionsMap: Record<string, string>): Promise<void> {
  const extDir = path.join(denDir, "extensions");
  const managed = await readManaged(extDir);
  const touched = [...new Set([...managed, ...Object.keys(extensionsMap).filter(isSafeExtensionName)])];
  await fs.rm(backupDir, { recursive: true, force: true });
  await fs.mkdir(backupDir, { recursive: true });
  const present: string[] = [];
  for (const name of touched) {
    try {
      await fs.cp(path.join(extDir, name), path.join(backupDir, name), { recursive: true });
      present.push(name);
    } catch (e) {
      if (!isEnoent(e)) throw e; // not on disk: restoring removes whatever the new sync puts there
    }
  }
  await fs.writeFile(path.join(backupDir, SNAPSHOT_FILE), JSON.stringify({ managed, touched, present }));
}

const isNameList = (v: unknown): v is string[] => Array.isArray(v) && v.every((n) => typeof n === "string" && isSafeExtensionName(n));

/**
 * Undo the last writeDenExtensions from its snapshot. Returns false when there is no snapshot (nothing changed).
 * A snapshot.json of the wrong shape throws before anything is touched. Each extension is copied to
 * `<name>.restoring` and renamed into place, so a failed copy never leaves a half-restored extension.
 */
export async function restoreDenExtensions(denDir: string, backupDir: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(backupDir, SNAPSHOT_FILE), "utf-8");
  } catch (e) {
    if (isEnoent(e)) return false;
    throw e;
  }
  const snap = JSON.parse(raw) as { managed?: unknown; touched?: unknown; present?: unknown };
  if (!isNameList(snap?.managed) || !isNameList(snap.touched) || !isNameList(snap.present) || !snap.present.every((n) => (snap.touched as string[]).includes(n))) {
    throw new Error(`malformed extensions snapshot at ${path.join(backupDir, SNAPSHOT_FILE)}`);
  }
  const { managed, touched, present } = snap as { managed: string[]; touched: string[]; present: string[] };
  const extDir = path.join(denDir, "extensions");
  await fs.mkdir(extDir, { recursive: true });
  // Stage every copy first; only then swap, so a copy error leaves the current extensions as they were.
  for (const name of present) {
    const staged = path.join(extDir, `${name}.restoring`);
    await fs.rm(staged, { recursive: true, force: true });
    await fs.cp(path.join(backupDir, name), staged, { recursive: true });
  }
  for (const name of touched) {
    await fs.rm(path.join(extDir, name), { recursive: true, force: true });
    if (present.includes(name)) await fs.rename(path.join(extDir, `${name}.restoring`), path.join(extDir, name));
  }
  await fs.writeFile(path.join(extDir, MANAGED_EXTENSIONS_FILE), JSON.stringify(managed));
  return true;
}
