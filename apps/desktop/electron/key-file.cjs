/**
 * The Mac app's key file (work-wolfpack-RUyVK7j): `keys.env` in the pack state dir, `NAME=value` lines, the same file
 * workerd (WORKERD_KEY_FILE) and the console (WOLFPACK_KEY_FILE) read. Follows the rules of packages/workerd/src/key-store.ts
 * (apps/desktop is CommonJS and cannot import the TS store): printable ASCII, none of  " ' \ $ #, mode 0600, atomic write,
 * lines that are not the one being set stay as they were. It differs in one way: a failed directory fsync (after the rename)
 * is swallowed, since the file is already in place.
 */
const fs = require("node:fs");
const path = require("node:path");

const KEYS_FILE = "keys.env";
const ANTHROPIC_ENV = "ANTHROPIC_API_KEY";
const DEEPGRAM_ENV = "DEEPGRAM_API_KEY";

/** "" when the key is safe to put in the file, else the reason. */
function keyProblem(key) {
	if (!/^[\x21-\x7e]+$/.test(key) || /["'\\$#]/.test(key)) return "The key contains characters that are not allowed in a key.";
	return "";
}

/** The value of `name` in `file`; "" when the file or the line is missing. Never log it. */
function readKey(file, name) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return "";
	}
	let value = "";
	for (const line of text.split(/\r?\n/)) {
		const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
		if (m && m[1] === name) value = m[2];
	}
	return value;
}

/** Set `name` in `file` (created if missing), atomically, mode 0600. Throws "not allowed" for an unsafe key before touching the file. */
function writeKey(file, name, key) {
	if (keyProblem(key)) throw new Error("the key has characters that are not allowed");
	// Read-modify-rename is unlocked, the same as key-store.ts: two writers at once can lose one update.
	let lines = [];
	try {
		lines = fs.readFileSync(file, "utf8").split("\n");
	} catch (e) {
		// Only a missing file is a new file. Anything else (permissions, a directory) must not be replaced blindly.
		if (e?.code !== "ENOENT") throw new Error(`keys.env exists but cannot be read (${e?.code ?? "error"}); not overwriting it`);
	}
	const out = [];
	let done = false;
	for (const line of lines) {
		const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
		if (m && m[1] === name) {
			if (!done) out.push(`${name}=${key}`);
			done = true;
		} else out.push(line);
	}
	if (!done) {
		while (out.length && out[out.length - 1] === "") out.pop();
		out.push(`${name}=${key}`);
	}
	while (out.length && out[out.length - 1] === "") out.pop();
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.rmSync(tmp, { force: true });
	try {
		const fd = fs.openSync(tmp, "wx", 0o600); // created with the final mode: never briefly wider
		try {
			fs.writeSync(fd, out.join("\n") + "\n");
			fs.chmodSync(tmp, 0o600);
			try {
				fs.chownSync(tmp, -1, fs.statSync(file).gid); // keep the old file's group (as key-store.ts does)
			} catch (e) {
				if (e?.code !== "EPERM" && e?.code !== "ENOENT") throw e;
			}
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(tmp, file);
		try {
			const dfd = fs.openSync(path.dirname(file), "r");
			try {
				fs.fsyncSync(dfd); // make the rename itself durable
			} finally {
				fs.closeSync(dfd);
			}
		} catch {
			/* a directory that cannot be fsynced: the file is already in place */
		}
	} catch (e) {
		fs.rmSync(tmp, { force: true });
		throw e;
	}
}

module.exports = { KEYS_FILE, ANTHROPIC_ENV, DEEPGRAM_ENV, keyProblem, readKey, writeKey };
