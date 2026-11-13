/**
 * THE PACK KEYS API (work-wolfpack-6EmU8pu). Behind the console's owner gate, it calls the hub with the caller's own device
 * token, which the gate has verified; the console never uses its own hub token here. The gate only checks that the token is
 * valid on the hub (GET /v1/wolves answers 2xx), not that it is an owner token; hubd's deviceCaller and operator checks are
 * the real limits.
 *   GET  /api/pack/machines/keys             the machines with key presence (masks only) and their public keys
 * Commands (including a sealed key.set) go through the Machines route, POST /api/machines/<hostId>/commands (machines-api.ts).
 *   POST /api/pack/machines/<hostId>/key/ack   accept a machine's changed key
 * The console never sees a key: the browser seals it to the machine's public key.
 */
import { WORKERD_TTL_MS } from "@wolfpack/protocol";
import { machineName } from "@wolfpack/protocol/health-lag";
import { bearerOf } from "../../core/ui/hub-auth.ts";
import { isRelayMode } from "../thread/relay-mode.ts";

const NO_STORE = { "Cache-Control": "no-store" };

export interface KeysApiDeps {
	gate: (req: Request) => Promise<string | Response>;
	env?: Record<string, string | undefined>;
	fetch?: typeof fetch;
	timeoutMs?: number;
}

const fail = (status: number, error: string, code: string): Response => Response.json({ error, code }, { status, headers: NO_STORE });

interface InvEntry {
	machine: string;
	kind: string;
	id: string;
	ageS?: number;
	parent?: string;
	busy?: boolean;
	transport?: "api" | "subscription";
	keys?: { slot: string; present: boolean; masked?: string; source?: "pack" | "env"; shadowsEnv?: boolean }[];
}

export function createKeysApi(d: KeysApiDeps) {
	const env = d.env ?? process.env;
	const doFetch = d.fetch ?? fetch;
	const hub = async (req: Request, method: string, path: string, body?: unknown, timeoutMs?: number): Promise<Response | undefined> => {
		const base = env.WOLFPACK_HUB_URL?.trim().replace(/\/+$/, "");
		// The caller's own bearer, already verified by the gate. Absent only if the gate was bypassed.
		const token = bearerOf(req.headers.get("authorization"));
		if (!base || !token) return undefined;
		return doFetch(`${base}${path}`, {
			method,
			headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(timeoutMs ?? d.timeoutMs ?? 5000),
		});
	};
	const noHub = (req: Request) =>
		env.WOLFPACK_HUB_URL?.trim() && !bearerOf(req.headers.get("authorization"))
			? fail(401, "sign in on this device first (no recently verified device token)", "unauthorized")
			: fail(501, "This console has no hub (WOLFPACK_HUB_URL is not set).", "unsupported");
	const down = () => fail(503, "The hub is not answering.", "hub_unreachable");

	return {
		async machines(req: Request): Promise<Response> {
			const g = await d.gate(req);
			if (g instanceof Response) return g;
			try {
				const [inv, keys] = await Promise.all([hub(req, "GET", "/v1/inventory"), hub(req, "GET", "/v1/machines/keys")]);
				if (!inv || !keys) return noHub(req);
				if (!inv.ok) return fail(502, "The hub could not list machines.", "failed");
				const all = ((await inv.json()) as { entries: InvEntry[] }).entries;
				const entries = all.filter((e) => e.kind === "workerd");
				const pub = keys.ok ? ((await keys.json()) as { keys: Record<string, { pubkey: string; fingerprint: string; changed: boolean }> }).keys : {};
				const machines = entries.map((e) => {
					const k = pub[e.id];
					return {
						hostId: e.id,
						machine: e.machine,
						// Online = the workerd reported within its TTL (the hub keeps stale entries listed with their age).
						online: (e.ageS ?? 0) * 1000 <= WORKERD_TTL_MS,
						// Wolves of this machine that are mid-reply, as the workerd reported them.
						midReply: all.filter((w) => w.kind === "wolfd" && w.parent === e.id && w.busy).map((w) => w.id),
						// Each wolf with its transport. A wolf that reports none is treated as subscription: a metered key is never assumed.
						wolves: all.filter((w) => w.kind === "wolfd" && w.parent === e.id).map((w) => ({ name: w.id, transport: w.transport === "api" ? "api" : "subscription" })),
						// A console entry on the same machine means dictation is needed here.
						servesConsole: all.some((c) => c.kind === "console" && c.machine === e.machine),
						canSetKeys: !!k && !!e.keys,
						...(k ? { pubkey: k.pubkey, fingerprint: k.fingerprint, keyChanged: k.changed } : {}),
						slots: e.keys ?? [],
					};
				});
				// Which wolves THIS console can address: in relay mode the hub routes any wolf by name; otherwise only the wolves on this machine.
				return Response.json({ machines, console: { relay: isRelayMode(env, true), machine: machineName(env) } }, { headers: NO_STORE });
			} catch {
				return down();
			}
		},
		async ack(req: Request, hostId: string): Promise<Response> {
			const g = await d.gate(req);
			if (g instanceof Response) return g;
			let body: unknown;
			try {
				body = await req.json();
			} catch {
				return fail(400, "The request body must be JSON with the fingerprint being accepted.", "invalid_request");
			}
			try {
				// The body names the fingerprint the owner looked at; the hub refuses (409) when the key has changed again.
				const r = await hub(req, "POST", `/v1/machines/${encodeURIComponent(hostId)}/key/ack`, body);
				if (!r) return noHub(req);
				return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json", ...NO_STORE } });
			} catch {
				return down();
			}
		},
	};
}

import { healthApi } from "./health-api.ts";

const KEY = Symbol.for("wolfpack.console.packKeys");
export function keysApi(env: Record<string, string | undefined> = process.env): ReturnType<typeof createKeysApi> {
	const h = globalThis as { [KEY]?: ReturnType<typeof createKeysApi> };
	return (h[KEY] ??= createKeysApi({ gate: (req) => healthApi(env).gate(req, "key change"), env }));
}
