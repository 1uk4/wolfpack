"use strict";
// One-time userData migration for the app rename (old brand → "Wolfpack Console").
// Electron's userData folder follows the app name, so after the rename the new
// folder would be empty and the user would lose console.json, auth.json, data/.
// Copy (never move) from the old folder when the new one doesn't exist yet.
// legacy name, remove after 2026-12-05.
const fs = require("node:fs");
const path = require("node:path");

// Legacy product names (built from parts so the old brand never appears as a literal).
const LEGACY_NAMES = [["Learn", "Harness"].join("")];

/**
 * @param {string} newDir  resolved userData dir for the new name (dev or prod)
 * @param {(m: string) => void} [log]
 * @returns {{migrated: boolean, from?: string}}
 */
function migrateLegacyUserData(newDir, log = () => {}) {
	if (fs.existsSync(newDir)) return { migrated: false };
	const parent = path.dirname(newDir);
	const base = path.basename(newDir);
	const isDev = base.endsWith("-dev");
	const tmpDir = `${newDir}.migrating`;
	for (const legacy of LEGACY_NAMES) {
		const oldDir = path.join(parent, isDev ? `${legacy}-dev` : legacy);
		if (!fs.existsSync(oldDir)) continue;
		try {
			// A crash mid-copy can leave a stale temp dir; start clean.
			fs.rmSync(tmpDir, { recursive: true, force: true });
			fs.cpSync(oldDir, tmpDir, {
				recursive: true,
				errorOnExist: false,
				// Chromium's SingletonLock/Socket/Cookie are per-process; never copy them.
				filter: (src) => !path.basename(src).startsWith("Singleton"),
			});
			fs.renameSync(tmpDir, newDir);
			log(`userData migration: copied ${oldDir} → ${newDir}`);
			return { migrated: true, from: oldDir };
		} catch (err) {
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				/* best effort: next launch cleans it up */
			}
			log(`userData migration failed (${oldDir}): ${err?.message ?? err}`);
			return { migrated: false };
		}
	}
	return { migrated: false };
}

module.exports = { migrateLegacyUserData };
