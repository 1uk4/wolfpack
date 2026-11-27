/**
 * GET/PUT /api/graph/groups, hub first (work-wolfpack-FnzgC6g).
 *
 * The groups are one list shared by every device of the pack: stored on the hub as pref `graph.groups` (hubd GET/PUT /v1/prefs/:key).
 * Hub prefs are keyed by the token's owner identity, and today every paired device maps to the single owner, so one hub = one list
 * for all consoles and phones. On a Mac-only install the hub runs in the app, so it is local. Without WOLFPACK_HUB_URL, without a
 * bearer, or when the hub does not answer, both routes use the console file (data/graph/groups.json) and the UI never breaks.
 *
 * Both copies carry `updatedAt`; the newer one wins, so an edit made while the hub was unreachable is not lost.
 *   GET: hub value and file compared by updatedAt. The file newer (and the hub reachable) -> answer the file and push it to the hub.
 *        Hub has no value yet -> seed it from the file (at most once per process). Hub down -> the file.
 *   PUT: body capped (413) and sanitized; time-stamped; always written to the file, and stored on the hub when it answers.
 */
import { bearerOf } from "../../core/ui/hub-auth.ts";
import { sanitizeGroups, type GraphGroups } from "../../core/graph/groups.ts";

export const GRAPH_GROUPS_PREF = "graph.groups";
export const MAX_GROUPS_BODY_BYTES = 64 * 1024;
const NO_STORE = { "Cache-Control": "no-store" };

export interface GroupsApiDeps {
	readLocal: () => GraphGroups;
	writeLocal: (raw: unknown) => GraphGroups;
	env?: Record<string, string | undefined>;
	fetch?: typeof fetch;
	timeoutMs?: number;
	now?: () => number;
}

/** The body text, or null once it grows past the cap (never reads more than the cap plus one chunk). */
async function readCapped(req: Request, max: number): Promise<string | null> {
	const declared = Number(req.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > max) return null;
	if (!req.body) return "";
	const reader = req.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > max) {
			void reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(value);
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

export function createGroupsApi(d: GroupsApiDeps) {
	const doFetch = d.fetch ?? fetch;
	const now = d.now ?? Date.now;
	let seeded = false;
	let pending: Promise<unknown> = Promise.resolve();

	/** One prefs call: the parsed `{value}` on 2xx, else null (not configured, no bearer, unreachable or refused). */
	async function hub(req: Request, method: "GET" | "PUT", body?: unknown): Promise<{ value: unknown } | null> {
		const env = d.env ?? process.env;
		const base = env.WOLFPACK_HUB_URL?.trim().replace(/\/+$/, "");
		const token = bearerOf(req.headers.get("authorization"));
		if (!base || !token) return null;
		try {
			const r = await doFetch(`${base}/v1/prefs/${GRAPH_GROUPS_PREF}`, {
				method,
				headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
				...(body === undefined ? {} : { body: JSON.stringify({ value: body }) }),
				signal: AbortSignal.timeout(d.timeoutMs ?? 4000),
			});
			if (!r.ok) return null;
			const json = (await r.json()) as { value?: unknown };
			return { value: json.value ?? null };
		} catch {
			return null;
		}
	}

	return {
		/** Resolves when background pushes to the hub (seed, newer file) have finished. For tests. */
		settled: () => pending,

		async get(req: Request): Promise<Response> {
			const remote = await hub(req, "GET");
			const local = d.readLocal();
			if (remote && remote.value !== null) {
				const fromHub = sanitizeGroups(remote.value);
				if ((local.updatedAt ?? 0) > (fromHub.updatedAt ?? 0)) {
					pending = hub(req, "PUT", local).catch(() => {}); // the file is newer: the hub catches up
					return Response.json(local, { headers: NO_STORE });
				}
				return Response.json(fromHub, { headers: NO_STORE });
			}
			if (remote && local.groups.length > 0 && !seeded) {
				seeded = true;
				pending = hub(req, "PUT", local).catch(() => {}); // one-time seed; the file stays
			}
			return Response.json(local, { headers: NO_STORE });
		},

		async put(req: Request): Promise<Response> {
			const text = await readCapped(req, MAX_GROUPS_BODY_BYTES);
			if (text === null) return Response.json({ error: "body too large" }, { status: 413 });
			let body: unknown;
			try {
				body = JSON.parse(text);
			} catch {
				return Response.json({ error: "invalid JSON body" }, { status: 400 });
			}
			const groups = { ...sanitizeGroups(body), updatedAt: now() };
			const saved = d.writeLocal(groups); // always: an offline edit must survive
			await hub(req, "PUT", groups);
			return Response.json(saved, { headers: NO_STORE });
		},
	};
}
