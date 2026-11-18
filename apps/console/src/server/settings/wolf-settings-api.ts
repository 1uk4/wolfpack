/**
 * THE WOLF SETTINGS API: Response-returning handlers over a ConsoleClient for the Settings page (view, save with If-Match, reveal,
 * restart). Same shape as prompts-api.ts: the request-scoped client carries the browser's own device token (never the hub token),
 * and in relay mode the hub tunnels the call to the wolf's host. Errors keep the protocol's status per `code` (400, 409, 429...) and
 * pass `details` through (a 429 carries `retryAfterSeconds`, a number).
 */
import type { ConsoleClient } from "@wolfpack/client";
import { HUB_AUTH_HEADER } from "../../core/ui/hub-auth.ts";
import { getConsoleClient } from "../thread/console-client.ts";
import type { ClientSource } from "../thread/thread-api.ts";
import { packModelOptions, type ModelOption } from "../pack/model-options.ts";

export interface WolfSettingsApiOptions {
	/** The model catalog the model saves are checked against (default: the Pack's). */
	catalog?: () => ModelOption[];
}

/** The catalog provider a wolf's pi provider serves: the Claude subscription (claude-stateless) serves Anthropic's models. */
const catalogProvider = (piProvider: string): string => (piProvider === "claude-stateless" || piProvider === "claude-bridge" ? "anthropic" : piProvider);

const bad = (error: string): Response => json({ error, code: "invalid_request" }, 400);

const STATUS_BY_CODE: Record<string, number> = {
	not_found: 404,
	unauthorized: 401,
	forbidden: 403,
	invalid_request: 400,
	conflict: 409,
	too_large: 413,
	rate_limited: 429,
	version_mismatch: 426,
	engine_error: 502,
};

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

function failure(err: unknown): Response {
	if (err instanceof Error && err.name === "NotFoundError") return json({ error: err.message, code: "not_found" }, 404);
	if (err instanceof Error && err.name === "ProtocolError") {
		const e = err as Error & { code?: string; hubAuth?: boolean; details?: Record<string, string | number> };
		const code = e.code ?? "engine_error";
		return Response.json(
			{ error: err.message, code, ...(e.details ? { details: e.details } : {}) },
			{ status: STATUS_BY_CODE[code] ?? 502, ...(e.hubAuth === true ? { headers: { [HUB_AUTH_HEADER]: "required" } } : {}) },
		);
	}
	console.error("[wolf-settings-api] unexpected error:", err);
	return json({ error: "Internal error" }, 500);
}

const unsupported = (): Response => json({ error: "wolf settings are not available on this console (no wolf or hub configured)", code: "engine_error" }, 503);

export function createWolfSettingsApi(source: ClientSource, opts: WolfSettingsApiOptions = {}) {
	const catalog = opts.catalog ?? packModelOptions;
	/** A plain refusal when a model in `set` is not allowed for this wolf, else undefined. Null clears a key and is always fine. */
	const modelProblem = async (wolf: string, set: Record<string, unknown>): Promise<Response | undefined> => {
		const keys = Object.keys(set);
		if (!keys.some((k) => k === "memory.model" || /^(models|tiers)\.(main|smart|fast)\.(model|provider)$/.test(k))) return undefined;
		const models = catalog(); // once per save
		const mem = set["memory.model"];
		if (typeof mem === "string" && !models.some((m) => m.id === mem && m.provider === "anthropic")) return bad(`Memory can only use an Anthropic model from the catalog; "${mem}" is not one.`);
		const c = source();
		const view = c.getWolfSettings ? await c.getWolfSettings(wolf) : undefined;
		const cfg = (view?.config ?? {}) as { models?: Record<string, { provider?: unknown } | undefined> };
		const running = (view as { tierProviders?: Record<string, string> } | undefined)?.tierProviders ?? {};
		for (const tier of ["main", "smart", "fast"]) {
			const newProvider = set[`models.${tier}.provider`];
			if (typeof newProvider === "string" && !models.some((m) => m.provider === catalogProvider(newProvider))) return bad(`"${newProvider}" is not a provider in the catalog.`);
			const model = tier === "main" ? set["models.main.model"] : (set[`models.${tier}.model`] ?? set[`tiers.${tier}.model`]);
			const tierModel = [set[`models.${tier}.model`], set[`tiers.${tier}.model`]].filter((v): v is string => typeof v === "string");
			if (tier === "main" && typeof model === "string" && !tierModel.includes(model)) tierModel.push(model);
			if (tierModel.length === 0) continue;
			// The provider the model must belong to: the one in this same save, else wolf.yaml's, else the one the wolf runs on (anthropic only if nothing says).
			const own = typeof newProvider === "string" ? newProvider : (cfg.models?.[tier]?.provider as string | undefined) ?? running[tier] ?? "anthropic";
			const want = catalogProvider(own);
			for (const id of tierModel) if (!models.some((m) => m.id === id && m.provider === want)) return bad(`"${id}" is not a ${want} model in the catalog, so ${wolf} cannot use it for ${tier}.`);
		}
		return undefined;
	};
	const run = async (fn: (c: ConsoleClient) => Promise<Response>): Promise<Response> => {
		try {
			return await fn(source());
		} catch (err) {
			return failure(err);
		}
	};
	return {
		get: (wolf: string) => run(async (c) => (c.getWolfSettings ? json(await c.getWolfSettings(wolf)) : unsupported())),
		async save(wolf: string, req: Request): Promise<Response> {
			const body = (await req.json().catch(() => null)) as { set?: unknown } | null;
			if (!body || !body.set || typeof body.set !== "object" || Array.isArray(body.set)) return json({ error: "body must be {set: {key: value|null}}", code: "invalid_request" }, 400);
			const set = body.set as Record<string, unknown>;
			const ifMatch = req.headers.get("if-match");
			if (!ifMatch) return json({ error: "If-Match is required: send the etag of the settings you loaded", code: "invalid_request" }, 400);
			return run(async (c) => {
				const refused = await modelProblem(wolf, set);
				if (refused) return refused;
				return c.putWolfSettings ? json(await c.putWolfSettings(wolf, set, ifMatch)) : unsupported();
			});
		},
		async reveal(wolf: string, req: Request): Promise<Response> {
			const body = (await req.json().catch(() => null)) as { source?: unknown; name?: unknown } | null;
			if (!body || (body.source !== "env" && body.source !== "config") || typeof body.name !== "string" || !body.name) return json({ error: "body must be {source: 'env'|'config', name}", code: "invalid_request" }, 400);
			const { source: src, name } = body as { source: "env" | "config"; name: string };
			return run(async (c) => (c.revealWolfSetting ? json(await c.revealWolfSetting(wolf, src, name)) : unsupported()));
		},
		restart: (wolf: string) => run(async (c) => (c.restartWolf ? json(await c.restartWolf(wolf)) : unsupported())),
	};
}

export const wolfSettingsApi = (): ReturnType<typeof createWolfSettingsApi> => createWolfSettingsApi(getConsoleClient);
