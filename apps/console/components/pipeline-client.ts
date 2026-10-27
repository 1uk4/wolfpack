/**
 * Browser fetch helper for the Dewey pipeline route. Same KbResult contract
 * as kb-client.ts: resolves, never throws; 409 = "unavailable".
 */
import type { KbPipelineResponse } from "@/src/core";
import type { KbFailureReason, KbResult } from "./kb-client";

export async function fetchKbPipeline(librarian: string): Promise<KbResult<KbPipelineResponse>> {
	let res: Response;
	try {
		res = await fetch(`/api/wolves/${encodeURIComponent(librarian)}/kb/pipeline`, { cache: "no-store" });
	} catch (err) {
		return { ok: false, reason: "error", message: err instanceof Error ? err.message : "network error" };
	}
	if (res.ok) {
		try {
			return { ok: true, data: (await res.json()) as KbPipelineResponse };
		} catch {
			return { ok: false, reason: "error", message: "response is not JSON" };
		}
	}
	const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
	const reason: KbFailureReason = res.status === 409 ? "unavailable" : res.status === 404 ? "not_found" : "error";
	const message = body?.error ?? `HTTP ${res.status}`;
	return body?.code ? { ok: false, reason, message, code: body.code } : { ok: false, reason, message };
}
