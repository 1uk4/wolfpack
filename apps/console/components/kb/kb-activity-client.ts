/**
 * Browser fetch helper for the KB activity route. Same KbResult contract as kb-client.ts: resolves, never throws; 409 = "unavailable".
 */
import type { KbActivityResponse } from "@/src/core";
import { dataStore, StoreHttpError } from "@/src/core";
import type { KbFailureReason } from "./kb-client";

/** `unauthorized`: the browser has no (or a revoked) hub token. */
export type KbActivityFailureReason = KbFailureReason | "unauthorized";
export type KbActivityResult = { ok: true; data: KbActivityResponse } | { ok: false; reason: KbActivityFailureReason; message: string; code?: string; hubAuth?: boolean };

export interface KbActivityParams {
	since?: string;
	before?: string;
	limit?: number;
	domain?: string;
}

/** `maxAgeMs`: reuse a stored answer younger than this (a page mount); 0 (the default) always revalidates with the ETag. */
export async function fetchKbActivity(params: KbActivityParams = {}, maxAgeMs = 0): Promise<KbActivityResult> {
	const q = new URLSearchParams();
	if (params.since) q.set("since", params.since);
	if (params.before) q.set("before", params.before);
	if (params.limit !== undefined) q.set("limit", String(params.limit));
	if (params.domain) q.set("domain", params.domain);
	let res: { status: number; body: unknown; headers: Headers };
	try {
		return { ok: true, data: await dataStore.load<KbActivityResponse>(`/api/kb/activity${q.size ? `?${q}` : ""}`, { maxAgeMs }) };
	} catch (err) {
		if (!(err instanceof StoreHttpError)) return { ok: false, reason: "error", message: err instanceof Error ? err.message : "network error" };
		res = err;
	}
	const body = res.body as { error?: string; code?: string } | null;
	const reason: KbActivityFailureReason = res.status === 401 ? "unauthorized" : res.status === 409 ? "unavailable" : res.status === 404 ? "not_found" : "error";
	const message = body?.error ?? `HTTP ${res.status}`;
	const out: KbActivityResult = { ok: false, reason, message };
	if (body?.code) out.code = body.code;
	// Only the hub's own marker means "this browser is not paired"; any other 401 is just unauthorized.
	if (res.status === 401 && res.headers.get("X-Wolfpack-Hub-Auth")?.toLowerCase() === "required") out.hubAuth = true;
	return out;
}
