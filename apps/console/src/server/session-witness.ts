/**
 * SESSION WITNESS: which browser tokens the hub has recently accepted, as seen by the console itself.
 *
 * The console has no session of its own: a browser is "signed in" when the hub accepts its device token. Pack health must keep working
 * (and its restart action must stay protected) while the hub is down or frozen, when the hub cannot be asked. So every hub call the
 * console already makes on a browser's behalf (console-client.ts), and the restart route's own live check, report their outcome here:
 * a success marks the token as verified now, a hub 401 forgets it.
 *
 * The witness is the FALLBACK only (health-api.ts, RESTART AUTH): while the hub is reachable the restart route asks the hub live and a
 * revoked device is refused (and forgotten here) at once. While the hub is down or frozen the witness decides: a bearer is accepted only
 * if the hub accepted it within `ttlMs` (default 72 h, WOLFPACK_HEALTH_SESSION_TTL_H). So a device revoked while the hub is down keeps
 * restart rights for at most 72 h after its last successful hub call.
 *
 * Only SHA-256 hashes are kept, never tokens. With a `file` (WOLFPACK_DATA_DIR/health-sessions.json, mode 0600) the hashes survive a
 * console restart, so a restart still works after the console itself came back while the hub is down. Without one they live in memory.
 * Writes: a token seen for the first time (or again after expiring) and a 401 are written at once; refreshes of a known token at most
 * every 10 min. Each write goes to a unique tmp file (pid + random) renamed into place. Expired entries are dropped on load and on use.
 */
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface SessionWitness {
	verified(token: string): void;
	rejected(token: string): void;
	/** Was this token accepted by the hub within the TTL? */
	isRecent(token: string): boolean;
	/** Short, non-reversible id of a token for audit logs. */
	fingerprint(token: string): string;
}

const MAX_ENTRIES = 256;
/** Writing the file on every hub call would be wasteful: refreshes of known tokens are written at most this often. */
const PERSIST_EVERY_MS = 10 * 60_000;
export const DEFAULT_TTL_MS = 72 * 3600_000;

const hashOf = (t: string) => createHash("sha256").update(t).digest("hex");

export function createSessionWitness(o: { file?: string; ttlMs?: number; now?: () => number } = {}): SessionWitness {
	const ttl = o.ttlMs ?? DEFAULT_TTL_MS;
	const now = o.now ?? Date.now;
	const seen = new Map<string, number>();
	const live = (at: number | undefined): at is number => at !== undefined && now() - at <= ttl;
	if (o.file) {
		try {
			const raw = JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ o.file, "utf8")) as unknown;
			if (raw && typeof raw === "object") for (const [h, at] of Object.entries(raw)) if (/^[0-9a-f]{64}$/.test(h) && typeof at === "number" && live(at)) seen.set(h, at);
		} catch {
			/* absent or corrupt: start empty (browsers re-verify on their next hub call) */
		}
	}
	let persistedAt = -Infinity;
	const persist = () => {
		if (!o.file) return;
		persistedAt = now();
		const tmp = `${o.file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
		try {
			fs.mkdirSync(/*turbopackIgnore: true*/ path.dirname(o.file), { recursive: true });
			fs.writeFileSync(/*turbopackIgnore: true*/ tmp, JSON.stringify(Object.fromEntries(seen)), { mode: 0o600 });
			fs.renameSync(/*turbopackIgnore: true*/ tmp, o.file);
		} catch (e) {
			fs.rmSync(/*turbopackIgnore: true*/ tmp, { force: true });
			console.warn(`console: could not persist health sessions: ${e instanceof Error ? e.message : String(e)}`);
		}
	};
	return {
		verified(token) {
			const h = hashOf(token);
			const known = live(seen.get(h));
			seen.delete(h);
			seen.set(h, now());
			while (seen.size > MAX_ENTRIES) seen.delete(seen.keys().next().value as string);
			if (!known || now() - persistedAt > PERSIST_EVERY_MS) persist();
		},
		rejected(token) {
			if (seen.delete(hashOf(token))) persist();
		},
		isRecent(token) {
			const h = hashOf(token);
			const at = seen.get(h);
			if (live(at)) return true;
			if (at !== undefined) seen.delete(h); // expired: drop it (written with the next change)
			return false;
		},
		fingerprint: (token) => hashOf(token).slice(0, 12),
	};
}

const KEY = Symbol.for("wolfpack.console.sessionWitness");
type Holder = { [KEY]?: SessionWitness };

/** The process-wide witness (shared by every route bundle). Persisted under WOLFPACK_DATA_DIR when that is set. */
export function sessionWitness(env: Record<string, string | undefined> = process.env): SessionWitness {
	const h = globalThis as Holder;
	if (!h[KEY]) {
		const dir = env.WOLFPACK_DATA_DIR?.trim();
		const ttlH = Number(env.WOLFPACK_HEALTH_SESSION_TTL_H);
		h[KEY] = createSessionWitness({ ...(dir ? { file: path.join(path.resolve(dir), "health-sessions.json") } : {}), ...(ttlH > 0 ? { ttlMs: ttlH * 3600_000 } : {}) });
	}
	return h[KEY];
}

/** Test seam: replace (or clear) the process witness. */
export function setSessionWitness(w: SessionWitness | undefined): void {
	(globalThis as Holder)[KEY] = w;
}
