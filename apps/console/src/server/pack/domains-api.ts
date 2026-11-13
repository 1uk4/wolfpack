/**
 * THE PACK PANEL'S DOMAINS API (work-wolfpack-I2AysMu). Each call goes through the console's owner gate (the same one as restart)
 * and then makes a real call to hubd /v1/registry/domains with the caller's own device token, which the gate has verified; the
 * console never uses its own hub token here. The gate only checks that the token is valid on the hub (GET /v1/wolves answers
 * 2xx), not that it is an owner token; hubd's deviceCaller and operator checks are the real limits.
 *   GET    /api/pack/domains          200 {domains: [{name, label?, description?, color?, created?}]}
 *   POST   /api/pack/domains          {name, label?, description?, color?}   201 {domain}
 *   PATCH  /api/pack/domains/<name>   {label?, description?, color?}         200 {domain}   (the name cannot change)
 *   DELETE /api/pack/domains/<name>   200 {deleted}   (the hub keeps the domain's KB folder and entries)
 * Reserved names are refused by the hub (400, its words are shown). Errors are {error: <plain words>, code, wolves?}: 400 invalid input (checked here, before the hub) | 401/429 the owner gate |
 * 404 no such domain | 409 duplicate, or still subscribed (wolves named) | 501 no hub configured | 502 the hub refuses this console
 * or failed | 503 the hub is not answering. Subscriptions are not managed here (wolf settings).
 */
import { bearerOf } from "../../core/ui/hub-auth.ts";

const NO_STORE = { "Cache-Control": "no-store" };
const NEW_NAME = /^[a-z0-9]{1,32}$/;
const EXISTING_NAME = /^[a-z0-9][a-z0-9-]{0,38}$/; // edit and delete must still reach a legacy hyphenated domain
const COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const MAX_TEXT = 200;
const MAX_DESCRIPTION = 1000;

export interface DomainsApiDeps {
	/** The owner gate: who asked, or the 401/429 Response. */
	gate: (req: Request) => Promise<string | Response>;
	env?: Record<string, string | undefined>;
	fetch?: typeof fetch;
	timeoutMs?: number;
}

const fail = (status: number, error: string, code: string, extra: Record<string, unknown> = {}): Response =>
	Response.json({ error, code, ...extra }, { status, headers: NO_STORE });

type Fields = { label?: string; description?: string; color?: string };

/** Pick and check label, description and colour; a string error means invalid. */
function fieldsOf(body: Record<string, unknown>, allowName: boolean): Fields | string {
	const out: Fields = {};
	for (const k of Object.keys(body)) if (!(k === "label" || k === "description" || k === "color" || (allowName && k === "name"))) return k === "name" ? "A domain's name cannot be changed." : `Unknown field "${k}".`;
	for (const [k, max] of [["label", MAX_TEXT], ["description", MAX_DESCRIPTION]] as const) {
		const v = body[k];
		if (v === undefined) continue;
		if (typeof v !== "string") return `The ${k} must be text.`;
		if (v.length > max) return `The ${k} is too long (up to ${max} characters).`;
		out[k] = v;
	}
	if (body.color !== undefined) {
		if (typeof body.color !== "string" || !COLOR.test(body.color)) return "The colour must be a hex colour like #3b82f6.";
		out.color = body.color;
	}
	return out;
}

export function createDomainsApi(d: DomainsApiDeps) {
	const env = d.env ?? process.env;
	const doFetch = d.fetch ?? fetch;

	/** One hub call. Returns the parsed JSON on 2xx, else the Response to send. */
	async function hub(req: Request, method: string, path: string, body: unknown, name?: string): Promise<{ ok: true; json: Record<string, unknown> } | { ok: false; res: Response }> {
		const base = env.WOLFPACK_HUB_URL?.trim().replace(/\/+$/, "");
		const token = bearerOf(req.headers.get("authorization"));
		if (!base) return { ok: false, res: fail(501, "This console has no hub to manage domains on (WOLFPACK_HUB_URL is not set).", "unsupported") };
		if (!token) return { ok: false, res: fail(401, "sign in on this device first (no recently verified device token)", "unauthorized") };
		let r: Response;
		try {
			r = await doFetch(`${base}${path}`, {
				method,
				headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(d.timeoutMs ?? 5000),
			});
		} catch {
			return { ok: false, res: fail(503, "The hub is not answering, so domains cannot be read or changed right now.", "hub_unreachable") };
		}
		let json: Record<string, unknown> = {};
		try {
			json = (await r.json()) as Record<string, unknown>;
		} catch {
			/* no body */
		}
		if (r.ok) return { ok: true, json };
		const message = typeof json.message === "string" ? json.message : "";
		const details = (json.details ?? {}) as { wolves?: unknown };
		const wolves = (Array.isArray(details.wolves) ? details.wolves.map(String) : typeof details.wolves === "string" ? details.wolves.split(",") : []).map((w) => w.trim()).filter(Boolean);
		if (r.status === 409 && wolves.length) {
			return { ok: false, res: fail(409, `Can't delete ${name}: these wolves are still subscribed to it: ${wolves.join(", ")}. Unsubscribe them in each wolf's settings first.`, "subscribed", { wolves }) };
		}
		if (r.status === 409) {
			return { ok: false, res: fail(409, method === "POST" ? `A domain named ${name} already exists.` : message || "The hub refused: that conflicts with the current state.", "conflict") };
		}
		if (r.status === 404) return { ok: false, res: fail(404, `There is no domain named ${name}.`, "not_found") };
		if (r.status === 400) return { ok: false, res: fail(400, message || "The hub did not accept those values.", "invalid_request") };
		if (r.status === 401 || r.status === 403) return { ok: false, res: fail(502, "The hub does not allow this console to change domains (its token is not an operator token).", "hub_forbidden") };
		return { ok: false, res: fail(502, "The hub failed on this request. Try again in a moment.", "failed") };
	}

	const readBody = async (req: Request): Promise<Record<string, unknown> | Response> => {
		try {
			const b = await req.json();
			if (b && typeof b === "object" && !Array.isArray(b)) return b as Record<string, unknown>;
		} catch {
			/* fall through */
		}
		return fail(400, "The request body must be a JSON object.", "invalid_request");
	};
	const send = (r: Awaited<ReturnType<typeof hub>>, status = 200): Response => (r.ok ? Response.json(r.json, { status, headers: NO_STORE }) : r.res);

	return {
		async list(req: Request): Promise<Response> {
			const g = await d.gate(req);
			if (g instanceof Response) return g;
			return send(await hub(req, "GET", "/v1/registry/domains", undefined));
		},

		async create(req: Request): Promise<Response> {
			const g = await d.gate(req);
			if (g instanceof Response) return g;
			const body = await readBody(req);
			if (body instanceof Response) return body;
			const name = body.name;
			if (typeof name !== "string" || !NEW_NAME.test(name)) return fail(400, "Domain names are lower-case letters and digits only, up to 32 (no hyphens).", "invalid_request");
			const fields = fieldsOf(body, true);
			if (typeof fields === "string") return fail(400, fields, "invalid_request");
			return send(await hub(req, "POST", "/v1/registry/domains", { name, ...fields }, name), 201);
		},

		async update(req: Request, name: string): Promise<Response> {
			const g = await d.gate(req);
			if (g instanceof Response) return g;
			if (!EXISTING_NAME.test(name)) return fail(400, "That is not a valid domain name.", "invalid_request");
			const body = await readBody(req);
			if (body instanceof Response) return body;
			const fields = fieldsOf(body, false);
			if (typeof fields === "string") return fail(400, fields, "invalid_request");
			if (Object.keys(fields).length === 0) return fail(400, "Nothing to change: give a label, description or colour.", "invalid_request");
			return send(await hub(req, "PATCH", `/v1/registry/domains/${name}`, fields, name));
		},

		async remove(req: Request, name: string): Promise<Response> {
			const g = await d.gate(req);
			if (g instanceof Response) return g;
			if (!EXISTING_NAME.test(name)) return fail(400, "That is not a valid domain name.", "invalid_request");
			return send(await hub(req, "DELETE", `/v1/registry/domains/${name}`, undefined, name));
		},
	};
}

const KEY = Symbol.for("wolfpack.console.packDomains");

/** The process-wide API, behind the same owner gate as restart (health-api.ts). */
export function domainsApi(env: Record<string, string | undefined> = process.env): ReturnType<typeof createDomainsApi> {
	const h = globalThis as { [KEY]?: ReturnType<typeof createDomainsApi> };
	return (h[KEY] ??= createDomainsApi({
		gate: (req) => healthApi(env).gate(req, "domain change"),
		env,
	}));
}
import { healthApi } from "./health-api.ts";
