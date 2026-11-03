/**
 * THE DEVICES API (settings > Devices): list the hub's paired devices, revoke one, mint a pairing code for a new one. Composition over the
 * request-scoped ConsoleClient: the browser's own device token is the only credential (no console token, ever). A hub 401 is answered 401 +
 * the hub-auth marker (the browser signs out); a 403 (a worker token) and 404 pass through; a client without a hub answers 501.
 */
import type { ConsoleClient } from "@wolfpack/client";
import { HUB_AUTH_HEADER } from "../core/hub-auth.ts";
import { getConsoleClient } from "./console-client.ts";
import type { ClientSource } from "./thread-api.ts";

const STATUS: Record<string, number> = { unauthorized: 401, forbidden: 403, not_found: 404, invalid_request: 400, busy: 409 };

function fail(err: unknown): Response {
	const e = err as Error & { code?: string; hubAuth?: boolean };
	const message = e instanceof Error ? e.message : "Unexpected error";
	if (e?.hubAuth === true) return Response.json({ error: message, code: "unauthorized" }, { status: 401, headers: { [HUB_AUTH_HEADER]: "required" } });
	const code = typeof e?.code === "string" ? e.code : "engine_error";
	return Response.json({ error: message, code }, { status: STATUS[code] ?? 502 });
}

const unsupported = () => Response.json({ error: "devices need a hub (WOLFPACK_HUB_URL)", code: "invalid_request" }, { status: 501 });

/** The hub's pairing page for `code` (what a phone opens or scans), when the console knows the hub's public URL. */
export function pairLink(code: string, hubUrl = process.env.NEXT_PUBLIC_WOLFPACK_HUB_URL): string | undefined {
	const base = hubUrl?.trim().replace(/\/+$/, "");
	return base ? `${base}/pair?code=${encodeURIComponent(code)}` : undefined;
}

export function createDevicesApi(source: ClientSource, o: { hubUrl?: string } = {}) {
	const need = <K extends "listDevices" | "revokeDevice" | "mintPairingCode">(k: K): NonNullable<ConsoleClient[K]> | undefined => {
		const c = source();
		const f = c[k];
		return typeof f === "function" ? ((f as (...a: never[]) => unknown).bind(c) as NonNullable<ConsoleClient[K]>) : undefined;
	};
	return {
		async list(): Promise<Response> {
			try {
				const f = need("listDevices");
				return f ? Response.json(await f()) : unsupported();
			} catch (err) {
				return fail(err);
			}
		},
		async revoke(id: string): Promise<Response> {
			try {
				const f = need("revokeDevice");
				return f ? Response.json(await f(id)) : unsupported();
			} catch (err) {
				return fail(err);
			}
		},
		async mint(label?: string): Promise<Response> {
			try {
				const f = need("mintPairingCode");
				if (!f) return unsupported();
				const out = await f(label?.trim().slice(0, 64) || undefined);
				const url = pairLink(out.code, o.hubUrl ?? process.env.NEXT_PUBLIC_WOLFPACK_HUB_URL);
				return Response.json({ ...out, ...(url ? { url } : {}) });
			} catch (err) {
				return fail(err);
			}
		},
	};
}

export const devicesApi = () => createDevicesApi(getConsoleClient);
