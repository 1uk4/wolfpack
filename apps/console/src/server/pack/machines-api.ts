/**
 * THE MACHINES API (work-wolfpack-4qae7Hg): POST /api/machines/:id/commands, the console's proxy for the hub's command channel
 * (POST /v1/machines/:id/commands). Same shape as devices-api: the request-scoped ConsoleClient carries the browser's own device token,
 * a request with no bearer is answered 401 + the hub-auth marker before anything is read (this route carries sealed keys), a hub 401 is
 * answered 401 + the marker, a client without a hub answers 501. The hub's result is passed through with the hub's status; the body
 * is capped (413) and validated (400) here first so nothing oversized or malformed reaches the hub.
 * Log lines and key bytes are passed through untouched and never logged, and error texts are fixed strings: a client error message is
 * never echoed (it could carry the sealed value).
 * A 409/504 from the hub whose body is not a command result fails the client's schema check and becomes the fixed 502.
 */
import { CommandRequestSchema } from "@wolfpack/protocol";
import { bearerOf, HUB_AUTH_HEADER } from "../../core/ui/hub-auth.ts";
import { getConsoleClient } from "../thread/console-client.ts";
import type { ClientSource } from "../thread/thread-api.ts";

/** Largest request body accepted (a sealed key is far smaller). */
export const MAX_BODY_BYTES = 128 * 1024;
/** Longest host id accepted. */
export const MAX_HOST_ID = 128;

/** Mirrors the hub's mapping (POST /v1/machines/:id/commands): 409 for not_sent_*, 504 for a timeout, else 200. */
const statusOf = (code: string | undefined): number => (code === "not_sent_offline" || code === "not_sent_unsupported" ? 409 : code === "timeout" ? 504 : 200);

const tooLarge = () => Response.json({ error: "request too large", code: "invalid_request" }, { status: 413 });

/** The body text, or null when it is over the cap: content-length first, then a capped read (the header can lie or be absent). */
async function readCapped(req: Request): Promise<string | null> {
	const declared = Number(req.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
	if (!req.body) return "";
	const reader = req.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_BODY_BYTES) {
			await reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

export function createMachinesApi(source: ClientSource) {
	return {
		async command(req: Request, hostId: string): Promise<Response> {
			if (!bearerOf(req.headers.get("authorization"))) return Response.json({ error: "unauthorized", code: "unauthorized" }, { status: 401, headers: { [HUB_AUTH_HEADER]: "required" } });
			if (hostId.length === 0 || hostId.length > MAX_HOST_ID) return Response.json({ error: "invalid command", code: "invalid_request" }, { status: 400 });
			const text = await readCapped(req);
			if (text === null) return tooLarge();
			let body: unknown = null;
			try {
				body = JSON.parse(text);
			} catch {
				/* not JSON: fails the schema below */
			}
			const parsed = CommandRequestSchema.safeParse(body);
			if (!parsed.success) return Response.json({ error: "invalid command", code: "invalid_request" }, { status: 400 });
			const c = source();
			if (typeof c.machineCommand !== "function") return Response.json({ error: "machine commands need a hub (WOLFPACK_HUB_URL)", code: "invalid_request" }, { status: 501 });
			try {
				// Deliberately no req.signal: once the command is sent it cannot be taken back, so a browser that goes away must not cancel the wait.
				const out = await c.machineCommand(hostId, parsed.data);
				return Response.json(out, { status: statusOf(out.code) });
			} catch (err) {
				const e = err as Error & { code?: string; hubAuth?: boolean };
				if (e?.hubAuth === true || e?.code === "unauthorized") return Response.json({ error: "unauthorized", code: "unauthorized" }, { status: 401, headers: { [HUB_AUTH_HEADER]: "required" } });
				if (e?.code === "invalid_request") return Response.json({ error: "invalid command", code: "invalid_request" }, { status: 400 });
				return Response.json({ error: "the hub could not complete the request", code: "engine_error" }, { status: 502 });
			}
		},
	};
}

export const machinesApi = () => createMachinesApi(getConsoleClient);
