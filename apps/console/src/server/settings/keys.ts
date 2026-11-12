/**
 * Key reads for the console server (work-wolfpack-u6GH2kk). The Pack owns keys: Pack → Keys writes the machine's key file
 * (WOLFPACK_KEY_FILE) through workerd, and this module only reads it. The console's old key store (auth.json, WOLFPACK_AUTH_FILE) and
 * its GET/PUT/DELETE /api/keys routes are gone: nothing here reads, writes or seeds process.env from auth.json any more. The file is
 * left on disk untouched.
 *
 * Order: the Pack key file, then the real process env (dev .env.local, a service's environment). The Pack's keys are NOT put into
 * process.env: children would inherit them (a subscription process must never get the Anthropic key).
 */

import fs from "node:fs";
import { AUTH_PROVIDER_KEYS } from "../../core/settings/auth-keys.ts";

/** The key slots the Pack stores, as the env names they live under in the machine's key file. */
const PACK_KEY_NAMES: readonly string[] = ["ANTHROPIC_API_KEY", "DEEPGRAM_API_KEY"];

/** The machine's Pack key file: WOLFPACK_KEY_FILE only (same as workerd, no default path). Unset = no Pack key file. */
function packKeyFile(): string | undefined {
	return process.env.WOLFPACK_KEY_FILE?.trim() || undefined;
}

/** The key store's character check (workerd key-store.ts): printable ASCII, none of the shell-special ones. */
function validKeyChars(v: string): boolean {
	return /^[\x21-\x7e]+$/.test(v) && !/["'\\$#]/.test(v);
}

/**
 * The Pack's keys, read fresh from disk on every call (a key.set shows without a restart, a key.remove at once). Mirrors workerd's
 * readKeyFileEnv: CRLF lines, known slot names only, invalid values ignored. A world-writable file is refused (logged, never the value).
 * Absent/unreadable = {}. Read-only. The result is never copied into process.env.
 */
function packKeys(): Record<string, string> {
	const out: Record<string, string> = {};
	const file = packKeyFile();
	if (!file) return out;
	try {
		if (fs.statSync(file).mode & 0o002) {
			console.warn(`[keys] ignoring the Pack key file ${file}: it is world-writable`);
			return out;
		}
		for (const line of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
			const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
			const name = m?.[1];
			const value = m?.[2];
			if (name && value && PACK_KEY_NAMES.includes(name) && validKeyChars(value)) out[name] = value;
		}
	} catch {
		/* no key file: the real env answers */
	}
	return out;
}

/** The fresh-user switch (WOLFPACK_IGNORE_ENV_KEYS=1): env keys are invisible, so only the Pack key file counts. Read live per call. */
export function envKeysIgnored(): boolean {
	return process.env.WOLFPACK_IGNORE_ENV_KEYS === "1";
}

/**
 * The fresh-user switch's boot step, idempotent. Under WOLFPACK_IGNORE_ENV_KEYS=1 every key env var (the Pack slots and every provider's
 * key var) is deleted from process.env, because pi-ai reads provider keys from process.env natively at each request. Without the switch
 * it does nothing. The Pack's keys are never copied into the env. Runs once when this module loads; keyValue() also guards live.
 */
export function initKeyEnv(): void {
	if (!envKeysIgnored()) return;
	for (const name of [...PACK_KEY_NAMES, ...AUTH_PROVIDER_KEYS.map((p) => p.envVar)]) delete process.env[name];
}

initKeyEnv();

/**
 * The live value for one var: the Pack key file first, then the real env.
 */
export function keyValue(id: string): string | undefined {
	const packed = packKeys()[id];
	if (packed) return packed;
	if (envKeysIgnored()) return undefined;
	return process.env[id];
}

/** Would this model provider's key be present at request time? Providers without a plain key take none: present by definition. */
export function providerKeyPresent(provider: string): boolean {
	const info = AUTH_PROVIDER_KEYS.find((p) => p.id === provider);
	return info ? keyValue(info.envVar) !== undefined : true;
}
