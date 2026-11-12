"use strict";
/**
 * Safe updates (work-wolfpack-u6Z4dRY). Pure Node, no Electron imports.
 *
 * On the first launch of a new version: back up pack state and each wolf's data, run that version's migrations, record the
 * version. A failing migration puts the backup back and reports; nothing starts on half-migrated data.
 *
 * Backup layout (<backupDir>): last/state/…, last/wolves/<wolf>/…, last/manifest.json. Only the last backup is kept: the new one
 * is written to next/, then swapped in, and the old one goes to the Trash via the injected trash(path). Nothing is hard-deleted.
 *
 * Crash safety: in-progress.json ({from, to, startedAt}) is written after the swap and removed only after the new version is
 * recorded (or after a successful restore). If it is found at launch the previous update was interrupted: the backup is NOT
 * redone (last/ is still the good one), the data is restored from last/ and the update is reported as failed.
 *
 * Every directory created here is mode 0700 (the backup holds credentials); files keep their source modes.
 */
const fs = require("node:fs");
const path = require("node:path");

const VERSION_FILE = "app-version.json";
const MARKER_FILE = "in-progress.json";

/** Pack state: not backed up = logs and Electron caches (rebuilt on their own). Everything else is: hub/ (the KB), credentials, setup.json, hub token, seeds. */
const STATE_EXCLUDE = new Set([
	"logs", "Cache", "Code Cache", "GPUCache", "DawnCache", "Crashpad", "tmp",
	// The state dir defaults to Electron's userData, so Electron's own profile files live here too (and are locked while the app runs).
	"Local Storage", "Session Storage", "IndexedDB", "Preferences", "Network Persistent State", "Shared Dictionary", "blob_storage",
	"Service Worker", "WebStorage", "Trust Tokens", "TransportSecurity", "SharedStorage", "DIPS", "Partitions", "Dictionaries", "Network",
]);
/** Electron's own top-level files: exact names, plus SQLite's -journal/-wal/-shm suffixes. Singleton* are Chromium's lock/socket/cookie links. */
const isElectronProfileFile = (name) => /^(Singleton(Lock|Socket|Cookie)|Cookies|Local State|Visited Links|SharedStorage|DIPS)(-journal|-wal|-shm)?$/.test(name);
/** Wolf dir: workspaces (the owner's code and files), logs and scratch are not backed up. session.sqlite (+ -wal/-shm, at the wolf root and in den/) is the conversation store and IS backed up. */
const WOLF_TOP_EXCLUDE = new Set(["workspace", "workspaces", "logs", "scratch"]);

const isLogFile = (name) => name.endsWith(".log");
/** rel is relative to the state dir, "/"-separated. */
function stateExcluded(rel) {
	const parts = rel.split("/");
	return parts.length === 1 ? STATE_EXCLUDE.has(parts[0]) || isElectronProfileFile(parts[0]) || isLogFile(parts[0]) : false;
}
/** rel is relative to one wolf dir. den/logs and den/*.log sit inside a backed-up folder but are not backed up. */
function wolfExcluded(rel) {
	const parts = rel.split("/");
	const name = parts[parts.length - 1];
	if (parts.length === 1) return WOLF_TOP_EXCLUDE.has(name) || isLogFile(name);
	if (parts.length === 2 && parts[0] === "den") return name === "logs" || isLogFile(name);
	return false;
}

function parseVersion(v) {
	const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v));
	if (!m) throw new Error(`not a version: ${v}`);
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}
function cmp(a, b) {
	const x = parseVersion(a);
	const y = parseVersion(b);
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
	return 0;
}

function stamp() {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

/** mkdir -p with mode 0700 on every directory it creates. */
function mk(dir) {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writeJsonAtomic(file, value) {
	const tmp = `${file}.tmp-${process.pid}`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
		fs.renameSync(tmp, file);
	} catch (e) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* nothing to clean */
		}
		throw e;
	}
}

/** null = no version file. Throws a plain-words Error when the file is there but unusable. */
function readStoredVersion(stateDir) {
	let text;
	try {
		text = fs.readFileSync(path.join(stateDir, VERSION_FILE), "utf8");
	} catch (e) {
		if (e.code === "ENOENT") return null;
		throw new Error(`${VERSION_FILE} could not be read: ${e.message}`);
	}
	let v;
	try {
		v = JSON.parse(text).version;
		if (typeof v !== "string") throw new Error("no version string");
		parseVersion(v);
	} catch (e) {
		throw new Error(`${VERSION_FILE} is damaged (${e.message}); nothing was changed`);
	}
	return v;
}

/** Top-level entries of dir that are not excluded (excluded = judged by a name-only test on the top level). */
function topEntries(dir, excluded) {
	return fs.readdirSync(dir).filter((n) => !excluded(n));
}

/** Clone-copy src to dest; symlinks are copied as links, never followed. Inner excluded paths (relative to the entry root) are skipped. */
function copyEntry(src, dest, relBase, excluded) {
	fs.cpSync(src, dest, {
		recursive: true,
		mode: fs.constants.COPYFILE_FICLONE,
		verbatimSymlinks: true,
		dereference: false,
		filter: (s) => !excluded(`${relBase}${path.relative(src, s) ? `/${path.relative(src, s)}`.split(path.sep).join("/") : ""}`),
	});
}

/** Real directories only: a symlinked wolf dir is never followed (it could point anywhere). Every skipped entry is logged. */
function listWolves(wolvesDir, log = () => {}) {
	if (!fs.existsSync(wolvesDir)) return [];
	const wolves = [];
	for (const d of fs.readdirSync(wolvesDir, { withFileTypes: true })) {
		if (d.isDirectory() && !d.name.startsWith(".")) wolves.push(d.name);
		else log(`update: skipping ${path.join(wolvesDir, d.name)} (${d.isSymbolicLink() ? "symlink, not followed" : d.isDirectory() ? "hidden folder" : "not a folder"})`);
	}
	return wolves;
}

/** An install from before version tracking: its pack state is there but app-version.json is not. Judged by the state dir only: after a Settings Reset the wolves stay but the state is empty, and that is a fresh install. */
function looksInstalled(stateDir) {
	return ["setup.json", "credentials.json", "hub"].some((n) => fs.existsSync(path.join(stateDir, n)));
}

async function backup({ stateDir, wolvesDir, backupDir, from, to, trash, log }) {
	const next = path.join(backupDir, "next");
	const last = path.join(backupDir, "last");
	mk(backupDir);
	fs.chmodSync(backupDir, 0o700); // already there from an earlier version
	if (fs.existsSync(next)) {
		// A crashed earlier attempt. If the Trash refuses it, set it aside: a leftover must not block the backup.
		try {
			await trash(next);
		} catch (e) {
			const aside = path.join(backupDir, `next-stale-${stamp()}`);
			log(`update: could not trash a stale next/ (${e.message}); renamed to ${aside}`);
			fs.renameSync(next, aside);
		}
	}
	const copied = { state: [], wolves: {} };
	mk(path.join(next, "state"));
	for (const name of topEntries(stateDir, (n) => stateExcluded(n))) {
		copyEntry(path.join(stateDir, name), path.join(next, "state", name), name, stateExcluded);
		copied.state.push(name);
	}
	for (const wolf of listWolves(wolvesDir, log)) {
		const wd = path.join(wolvesDir, wolf);
		const out = path.join(next, "wolves", wolf);
		mk(out);
		copied.wolves[wolf] = [];
		for (const name of topEntries(wd, (n) => wolfExcluded(n))) {
			copyEntry(path.join(wd, name), path.join(out, name), name, wolfExcluded);
			copied.wolves[wolf].push(name);
		}
	}
	writeJsonAtomic(path.join(next, "manifest.json"), { from, to, time: new Date().toISOString(), copied });
	if (fs.existsSync(last)) {
		const old = path.join(backupDir, `old-${stamp()}`);
		fs.renameSync(last, old);
		fs.renameSync(next, last);
		try {
			await trash(old);
		} catch (e) {
			log(`update: could not trash the previous backup (${old}): ${e.message}`);
		}
	} else {
		fs.renameSync(next, last);
	}
}

/** Move src to dest, falling back to copy + trash across volumes. Never deletes. */
async function moveAside(src, dest, trash) {
	mk(path.dirname(dest));
	try {
		fs.renameSync(src, dest);
	} catch (e) {
		if (e.code !== "EXDEV") throw e;
		fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true, dereference: false });
		await trash(src);
	}
}

/** Put excluded-but-present paths (den/logs) from the moved-aside copy back into the restored entry. */
function rescueExcluded(asideEntry, liveEntry, rel, excluded) {
	let st;
	try {
		st = fs.lstatSync(asideEntry);
	} catch {
		return;
	}
	if (!st.isDirectory()) return;
	for (const n of fs.readdirSync(asideEntry)) {
		const childRel = `${rel}/${n}`;
		const a = path.join(asideEntry, n);
		const l = path.join(liveEntry, n);
		if (excluded(childRel)) {
			if (!fs.existsSync(l)) fs.cpSync(a, l, { recursive: true, verbatimSymlinks: true, dereference: false });
		} else rescueExcluded(a, l, childRel, excluded);
	}
}

/** Refuses (throws before touching anything) unless last/ was taken from the version the data is still at. */
async function restore({ stateDir, wolvesDir, backupDir, trash, expectFrom }) {
	const last = path.join(backupDir, "last");
	const manifest = JSON.parse(fs.readFileSync(path.join(last, "manifest.json"), "utf8"));
	if (manifest.from !== expectFrom) {
		throw new Error(`the backup is from version ${manifest.from} but the data is at ${expectFrom}; refusing to restore, nothing was changed`);
	}
	const failed = path.join(backupDir, `failed-${stamp()}`);
	const one = async (liveRoot, backRoot, asideRoot, excluded, names, keepVersion = false) => {
		mk(liveRoot);
		// Everything live that a backup would have covered goes aside (this includes files the migration created), then the backup comes back.
		// app-version.json stays in place (the backup copy overwrites it): a crash mid-restore must not lose the version.
		for (const name of topEntries(liveRoot, (n) => excluded(n) || (keepVersion && n === VERSION_FILE))) await moveAside(path.join(liveRoot, name), path.join(asideRoot, name), trash);
		for (const name of names) {
			fs.cpSync(path.join(backRoot, name), path.join(liveRoot, name), { recursive: true, mode: fs.constants.COPYFILE_FICLONE, verbatimSymlinks: true, dereference: false });
			rescueExcluded(path.join(asideRoot, name), path.join(liveRoot, name), name, excluded);
		}
	};
	await one(stateDir, path.join(last, "state"), path.join(failed, "state"), stateExcluded, manifest.copied.state, true);
	for (const [wolf, names] of Object.entries(manifest.copied.wolves)) {
		await one(path.join(wolvesDir, wolf), path.join(last, "wolves", wolf), path.join(failed, "wolves", wolf), wolfExcluded, names);
	}
	return failed;
}

/** Move (never delete) a marker that does not apply to the current data. */
function setMarkerAside(markerFile, log) {
	if (!fs.existsSync(markerFile)) return;
	const aside = path.join(path.dirname(markerFile), `in-progress.stale-${stamp()}.json`);
	fs.renameSync(markerFile, aside);
	log(`update: in-progress.json did not match this data; moved to ${aside}`);
}

function removeMarker(markerFile, log) {
	try {
		fs.unlinkSync(markerFile);
	} catch (e) {
		if (e.code !== "ENOENT") log(`update: could not remove ${markerFile}: ${e.message}`);
	}
}

/**
 * @param {{ stateDir: string, wolvesDir: string, version: string, migrations: Array<{version: string, name: string, run: Function}>,
 *   backupDir?: string, trash?: (p: string) => Promise<void>, log?: (l: string) => void }} o
 * @returns {Promise<{ok: true, ran: string[], backedUp: boolean} | {ok: false, stage: "version"|"backup"|"migration"|"restore", error: string, restored: boolean, failedDir?: string, backupDir: string}>}
 */
async function runUpdate({ stateDir, wolvesDir, version, migrations, backupDir, trash, log = () => {} }) {
	backupDir = backupDir ?? path.join(path.dirname(stateDir), `${path.basename(stateDir)} Backup`);
	trash =
		trash ??
		(async (p) => {
			const dest = path.join(backupDir, `superseded-${stamp()}`, path.basename(p));
			mk(path.dirname(dest));
			fs.renameSync(p, dest);
		});
	const versionFile = path.join(stateDir, VERSION_FILE);
	const markerFile = path.join(backupDir, MARKER_FILE);
	let stored;
	try {
		stored = readStoredVersion(stateDir);
	} catch (e) {
		return { ok: false, stage: "version", error: e.message, restored: false, backupDir };
	}
	if (stored === null) {
		if (!looksInstalled(stateDir)) {
			setMarkerAside(markerFile, log); // a marker here belongs to a state folder that is gone (Settings Reset)
			mk(stateDir);
			writeJsonAtomic(versionFile, { version });
			log(`update: first launch, recorded ${version}`);
			return { ok: true, ran: [], backedUp: false };
		}
		stored = "0.0.0"; // data from before version tracking: back up and run every migration
		log("update: data found without a version file, treating it as 0.0.0");
	}

	const failAndRestore = async (error) => {
		try {
			const failedDir = await restore({ stateDir, wolvesDir, backupDir, trash, expectFrom: stored });
			removeMarker(markerFile, log);
			return { ok: false, stage: "migration", error, restored: true, failedDir, backupDir };
		} catch (re) {
			// The marker stays: the next launch tries again from the untouched last/.
			return { ok: false, stage: "restore", error: `${error}; restore failed: ${re.message}`, restored: false, backupDir };
		}
	};

	if (fs.existsSync(markerFile)) {
		let marker = null;
		try {
			marker = JSON.parse(fs.readFileSync(markerFile, "utf8"));
			parseVersion(marker.to);
		} catch {
			marker = null;
		}
		const st = fs.statSync(stateDir);
		if (marker && (marker.from !== stored || marker.stateIno !== st.ino)) {
			setMarkerAside(markerFile, log); // written for another state folder or another version: not about this data
		} else if (marker && cmp(stored, marker.to) >= 0) {
			removeMarker(markerFile, log); // the update finished; only the marker removal was missed
		} else {
			log("update: found in-progress.json, the last update was interrupted; restoring from last/ without a new backup");
			return failAndRestore("the last update was interrupted");
		}
	}

	const c = cmp(stored, version);
	if (c === 0) return { ok: true, ran: [], backedUp: false };
	if (c > 0) {
		log(`update: WARNING data is from a newer Wolfpack (${stored}) than this app (${version}); running nothing`);
		return { ok: true, ran: [], backedUp: false };
	}
	try {
		await backup({ stateDir, wolvesDir, backupDir, from: stored, to: version, trash, log });
		const st = fs.statSync(stateDir);
		writeJsonAtomic(markerFile, { from: stored, to: version, startedAt: new Date().toISOString(), stateIno: st.ino }); // inode only: st_dev is not stable across reboots on macOS
	} catch (e) {
		return { ok: false, stage: "backup", error: `backup failed: ${e.message}`, restored: false, backupDir };
	}
	const due = migrations.filter((m) => cmp(m.version, stored) > 0 && cmp(m.version, version) <= 0).sort((a, b) => cmp(a.version, b.version));
	const ran = [];
	try {
		for (const m of due) {
			log(`update: migration ${m.version} ${m.name}`);
			await m.run({ stateDir, wolvesDir });
			ran.push(m.version);
		}
		writeJsonAtomic(versionFile, { version });
	} catch (e) {
		return failAndRestore(String(e?.message ?? e));
	}
	removeMarker(markerFile, log);
	return { ok: true, ran, backedUp: true };
}

module.exports = { runUpdate };
