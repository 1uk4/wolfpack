/**
 * The console's graduation client (work-wolfpack-F85qPOc): `graduateDirect` sends the owner's approval of a previewed graduation
 * (console route → hub graduate-direct, owner login only); `getPendingPreview` reads the prepared preview a wolf still holds.
 */
import type { GraduationContribution, GraduationPreview } from "@wolfpack/protocol";
import { fetchGraduateStatus } from "../kb/kb-client";

export type GraduateVia = "card" | "work" | "graph";

export type GraduateDirectResult =
	| { ok: true; itemId: string; domain: string; sent: number; archived: number; via: GraduateVia; approvedBy: { actor: string; device: string; at: string } }
	| { ok: false; status: number; code: string; message: string; alreadyGraduated: boolean };

/** How long a prepared preview stays confirmable. A copy of the harness's GRADUATION_PREVIEW_TTL_MS (6 h): that constant lives in @wolfpack/harness, which the browser bundle must not import, and @wolfpack/protocol does not export it. */
const PREVIEW_TTL_MS = 6 * 60 * 60 * 1000;

/** The hub answers 400 invalid_request "already graduated/archived" for a finished item; a 409 (a write that lost a race) or an already_graduated code means the same, except a pending approval request, which is not done. */
function isAlreadyGraduated(status: number, code: string, message: string): boolean {
	if (code === "already_graduated") return true;
	if (status === 409) return code !== "request_pending";
	return status === 400 && /already (graduated|archived)/i.test(message);
}

export async function graduateDirect(id: string, body: { contributions: GraduationContribution[]; summary?: string; via: GraduateVia; wolf?: string }): Promise<GraduateDirectResult> {
	let res: Response;
	try {
		res = await fetch(`/api/work/${encodeURIComponent(id)}/graduate-direct`, { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	} catch (err) {
		return { ok: false, status: 0, code: "network", message: err instanceof Error ? err.message : "network error", alreadyGraduated: false };
	}
	const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
	if (res.ok && data) return { ok: true, ...(data as Omit<Extract<GraduateDirectResult, { ok: true }>, "ok">) };
	const message = typeof data?.error === "string" ? data.error : typeof data?.message === "string" ? data.message : `HTTP ${res.status}`;
	const code = typeof data?.code === "string" ? data.code : "failed";
	return { ok: false, status: res.status, code, message, alreadyGraduated: isAlreadyGraduated(res.status, code, message) };
}

export type PendingPreviewResult = { ok: true; preview: GraduationPreview } | { ok: true; none: true } | { ok: false; message: string };

/** The preview the wolf holds for the item (a live job's result, or recovered from its token file after a restart); an expired one is none. */
export async function getPendingPreview(wolf: string, itemId: string): Promise<PendingPreviewResult> {
	const res = await fetchGraduateStatus(wolf, itemId);
	if (!res.ok) return { ok: false, message: res.message };
	const s = res.data;
	if (s.state !== "preview_ready") return { ok: true, none: true };
	const age = Date.now() - Date.parse(s.preview.createdAt);
	if (!Number.isFinite(age) || age > PREVIEW_TTL_MS) return { ok: true, none: true };
	return { ok: true, preview: s.preview };
}
