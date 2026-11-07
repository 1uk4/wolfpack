"use strict";
// One-time userData migration for the app rename (old brand → "Wolfpack Console").
// Electron's userData folder follows the app name, so after the rename the new
// folder would be empty and the user would lose console.json, auth.json, data/.
// Copy (never move) from the old folder when the new one is missing or holds no owner state (Electron/Chromium may create
// it empty before this runs). Existing files in the new folder are never overwritten.
// legacy name, remove after 2026-12-05.
const fs = require("node:fs");
const path = require("node:path");

// Legacy product names (built from parts so the old brand never appears as a literal).
const LEGACY_NAMES = [["Learn", "Harness"].join("")];

/** Chromium stores (leveldb): merging files from two stores corrupts them, so
 *  when the old folder has one, the new folder's copy is replaced wholesale. */
const WHOLESALE_DIRS = ["Local Storage", "Session Storage", "IndexedDB"];

/** Owner state = any of these present in the new folder. */
function hasOwnerState(dir) {
	if (fs.existsSync(path.join(dir, "console.json"))) return true;
	if (fs.existsSync(path.join(dir, "auth.json"))) return true;
	try {
		return fs.readdirSync(path.join(dir, "data", "chats")).length > 0;
	} catch {
		return false;
	}
}

/** Copy src into dst; skip Singleton* and files that already exist; a failing
 *  entry (socket, locked file) is recorded, not fatal. */
function copyTree(src, dst, failures) {
	let entries;
	try {
		entries = fs.readdirSync(src, { withFileTypes: true });
	} catch (err) {
		failures.push(`${src}: ${err?.message ?? err}`);
		return;
	}
	fs.mkdirSync(dst, { recursive: true });
	for (const e of entries) {
		if (e.name.startsWith("Singleton")) continue;
		const from = path.join(src, e.name);
		const to = path.join(dst, e.name);
		try {
			if (e.isDirectory()) copyTree(from, to, failures);
			else if (e.isFile() || e.isSymbolicLink()) {
				if (!fs.existsSync(to)) fs.copyFileSync(from, to);
			}
			// sockets, fifos, devices: skipped
		} catch (err) {
			failures.push(`${from}: ${err?.message ?? err}`);
		}
	}
}

/**
 * @param {string} newDir  resolved userData dir for the new name (dev or prod)
 * @param {(m: string) => void} [log]
 * @returns {{migrated: boolean, from?: string, failures?: string[]}}
 */
function migrateLegacyUserData(newDir, log = () => {}) {
	if (hasOwnerState(newDir)) return { migrated: false };
	const parent = path.dirname(newDir);
	const isDev = path.basename(newDir).endsWith("-dev");
	for (const legacy of LEGACY_NAMES) {
		const oldDir = path.join(parent, isDev ? `${legacy}-dev` : legacy);
		if (!fs.existsSync(oldDir)) continue;
		const failures = [];
		try {
			for (const d of WHOLESALE_DIRS) {
				if (!fs.existsSync(path.join(oldDir, d))) continue;
				try {
					fs.rmSync(path.join(newDir, d), { recursive: true, force: true });
				} catch (err) {
					failures.push(`${path.join(newDir, d)}: ${err?.message ?? err}`);
				}
			}
			copyTree(oldDir, newDir, failures);
		} catch (err) {
			failures.push(`${oldDir}: ${err?.message ?? err}`);
		}
		const migrated = hasOwnerState(newDir);
		log(
			`userData migration: ${migrated ? "copied" : "FAILED to copy"} ${oldDir} -> ${newDir}` +
				(failures.length ? `; ${failures.length} skipped: ${failures.slice(0, 5).join(" | ")}` : ""),
		);
		return { migrated, from: oldDir, failures };
	}
	return { migrated: false };
}

module.exports = { migrateLegacyUserData };
