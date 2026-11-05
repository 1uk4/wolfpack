/**
 * Browser fetch helper for the KB activity route. Same KbResult contract as kb-client.ts: resolves, never throws; 409 = "unavailable".
 */
import type { KbActivityResponse } from "@/src/core";
import type { KbFailureReason } from "./kb-client";

/** `unauthorized`: the browser has no (or a revoked) hub token. */
export type KbActivityFailureReason = KbFailureReason | "unauthorized";
export type KbActivityResult = { ok: true; data: KbActivityResponse } | { ok: false; reason: KbActivityFailureReason; message: string; code?: string };

export interface KbActivityParams {
	since?: string;
	before?: string;
	limit?: number;
	domain?: string;
}

export async function fetchKbActivity(params: KbActivityParams = {}): Promise<KbActivityResult> {
	const q = new URLSearchParams();
	if (params.since) q.set("since", params.since);
	if (params.before) q.set("before", params.before);
	if (params.limit !== undefined) q.set("limit", String(params.limit));
	if (params.domain) q.set("domain", params.domain);
	let res: Response;
	try {
		res = await fetch(`/api/kb/activity${q.size ? `?${q}` : ""}`, { cache: "no-store" });
	} catch (err) {
		return { ok: false, reason: "error", message: err instanceof Error ? err.message : "network error" };
	}
	if (res.ok) {
		try {
			return { ok: true, data: (await res.json()) as KbActivityResponse };
		} catch {
			return { ok: false, reason: "error", message: "response is not JSON" };
		}
	}
	const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
	const reason: KbActivityFailureReason = res.status === 401 ? "unauthorized" : res.status === 409 ? "unavailable" : res.status === 404 ? "not_found" : "error";
	const message = body?.error ?? `HTTP ${res.status}`;
	return body?.code ? { ok: false, reason, message, code: body.code } : { ok: false, reason, message };
}
