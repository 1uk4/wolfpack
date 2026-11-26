/**
 * Release notes for the update notice and What's New (work-wolfpack-DKce6er): the GitHub release body for a component or desktop tag.
 * The repo is public, so this is an unauthenticated GET to the releases API with a plain User-Agent (rate limit 60/h per IP). A release's
 * notes don't change, so a hit is kept for good, in memory and in `<cacheDir>/release-notes.json` (default ~/.wolfpack/console, or
 * WOLFPACK_CONSOLE_STATE_DIR; entries are validated on load, at most 200). Failures return null: a 404 or empty body is remembered for
 * ~10 minutes (so repeated opens do not hit GitHub), a 403/429 pauses every GitHub call for ~15 minutes, a network error is retried on the
 * next open. Concurrent gets of one tag share one request. The caller falls back to the plain release link.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface ReleaseNotes {
	tag: string;
	body: string;
	url: string;
}

/** component/vX.Y.Z or component/vX.Y.Z-main.N for console, hubd, wolfd, workerd and desktop. Anything else is never sent to GitHub. */
const TAG = /^(console|hubd|wolfd|workerd|desktop)\/v\d+\.\d+\.\d+(-main\.\d+)?$/;
const REPO = "1uk4/wolfpack";
const MAX_BODY = 100_000;
const MAX_ENTRIES = 200;
const MISS_TTL_MS = 10 * 60_000;
const BACKOFF_MS = 15 * 60_000;

export const isReleaseTag = (tag: string): boolean => TAG.test(tag);

export function createReleaseNotes(opts: { fetch?: typeof globalThis.fetch; cacheDir?: string; now?: () => number } = {}) {
	const doFetch = opts.fetch ?? globalThis.fetch;
	const now = opts.now ?? Date.now;
	const dir = opts.cacheDir ?? process.env.WOLFPACK_CONSOLE_STATE_DIR ?? path.join(homedir(), ".wolfpack", "console");
	const file = path.join(dir, "release-notes.json");
	let cache: Record<string, ReleaseNotes> | null = null;
	const misses = new Map<string, number>();
	const inflight = new Map<string, Promise<ReleaseNotes | null>>();
	let backoffUntil = 0;

	const load = (): Record<string, ReleaseNotes> => {
		if (cache) return cache;
		cache = {};
		try {
			const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
			if (raw && typeof raw === "object") {
				for (const [tag, v] of Object.entries(raw as Record<string, unknown>).slice(0, MAX_ENTRIES)) {
					const e = v as Partial<ReleaseNotes> | null;
					if (isReleaseTag(tag) && e && typeof e.body === "string" && e.body && typeof e.url === "string") cache[tag] = { tag, body: e.body, url: e.url };
				}
			}
		} catch {
			/* no file or unreadable: start empty */
		}
		return cache;
	};
	const save = () => {
		try {
			mkdirSync(dir, { recursive: true });
			const tmp = `${file}.${process.pid}.tmp`;
			writeFileSync(tmp, JSON.stringify(cache));
			renameSync(tmp, file);
		} catch {
			/* read-only state dir: the memory cache still works */
		}
	};

	async function fetchNotes(tag: string): Promise<ReleaseNotes | null> {
		try {
			const res = await doFetch(`https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`, {
				headers: { Accept: "application/vnd.github+json", "User-Agent": "wolfpack-console" },
				signal: AbortSignal.timeout(8000),
			});
			if (res.status === 403 || res.status === 429) {
				backoffUntil = now() + BACKOFF_MS;
				return null;
			}
			if (!res.ok) {
				misses.set(tag, now());
				return null;
			}
			const j = (await res.json()) as { body?: unknown; html_url?: unknown };
			const body = typeof j.body === "string" ? j.body.trim().slice(0, MAX_BODY) : "";
			if (!body) {
				misses.set(tag, now());
				return null;
			}
			const url = typeof j.html_url === "string" && j.html_url.startsWith("https://github.com/") ? j.html_url : `https://github.com/${REPO}/releases/tag/${tag}`;
			const notes = { tag, body, url };
			const c = load();
			const keys = Object.keys(c);
			if (keys.length >= MAX_ENTRIES && keys[0]) delete c[keys[0]];
			c[tag] = notes;
			save();
			return notes;
		} catch {
			return null;
		}
	}

	function get(tag: string): Promise<ReleaseNotes | null> {
		if (!isReleaseTag(tag)) return Promise.resolve(null);
		const hit = load()[tag];
		if (hit) return Promise.resolve(hit);
		const missAt = misses.get(tag);
		if (missAt !== undefined && now() - missAt < MISS_TTL_MS) return Promise.resolve(null);
		if (now() < backoffUntil) return Promise.resolve(null);
		let p = inflight.get(tag);
		if (!p) {
			p = fetchNotes(tag).finally(() => inflight.delete(tag));
			inflight.set(tag, p);
		}
		return p;
	}
	return { get };
}
