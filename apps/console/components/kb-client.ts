/**
 * Browser fetch helpers for the memory / KB routes (app/api/wolves/[name]/…).
 * Every helper resolves — never throws — to a KbResult:
 *   { ok: true, data } | { ok: false, reason, message, code? }
 * reason: "unavailable" = HTTP 409 (memory inert/not loaded, KB not served by
 * this wolf, …), "not_found" = 404, "error" = anything else (incl. network).
 * `code` is the protocol error code when the server sent one (e.g.
 * "memory_busy", "promote_unavailable") so callers can tell 409s apart.
 */
import type {
	ConsolidateResponse,
	KbEntryDetail,
	KbGraph,
	MemoryStatus,
	MemoryTopic,
	PromoteResponse,
	WorkRecordResponse,
} from "@/src/core";

export type KbFailureReason = "unavailable" | "not_found" | "error";
export type KbResult<T> = { ok: true; data: T } | { ok: false; reason: KbFailureReason; message: string; code?: string };

export interface KbGraphOptions {
	domain?: string;
	archivedWork?: boolean;
	wikilinks?: boolean;
	denTopics?: boolean;
}

const seg = encodeURIComponent;

async function request<T>(url: string, init?: RequestInit): Promise<KbResult<T>> {
	let res: Response;
	try {
		res = await fetch(url, { cache: "no-store", ...init });
	} catch (err) {
		return { ok: false, reason: "error", message: err instanceof Error ? err.message : "network error" };
	}
	if (res.ok) {
		try {
			return { ok: true, data: (await res.json()) as T };
		} catch {
			return { ok: false, reason: "error", message: "response is not JSON" };
		}
	}
	const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
	const message = body?.error ?? `HTTP ${res.status}`;
	const code = body?.code;
	const reason: KbFailureReason = res.status === 409 ? "unavailable" : res.status === 404 ? "not_found" : "error";
	return code ? { ok: false, reason, message, code } : { ok: false, reason, message };
}

export function fetchWolves(): Promise<KbResult<{ wolves: { id: string; name: string; host: string; status: string; librarian?: boolean }[] }>> {
	return request("/api/wolves");
}

export function fetchMemoryStatus(wolf: string, thread?: string): Promise<KbResult<MemoryStatus>> {
	const q = thread ? `?thread=${seg(thread)}` : "";
	return request(`/api/wolves/${seg(wolf)}/memory${q}`);
}

export function fetchMemoryTopic(wolf: string, id: string, scope?: "den" | "session"): Promise<KbResult<MemoryTopic>> {
	const q = scope ? `?scope=${scope}` : "";
	return request(`/api/wolves/${seg(wolf)}/memory/topics/${seg(id)}${q}`);
}

export function fetchWorkRecord(wolf: string, id: string): Promise<KbResult<WorkRecordResponse>> {
	return request(`/api/wolves/${seg(wolf)}/work/${seg(id)}/record`);
}

export function fetchKbGraph(librarian: string, opts: KbGraphOptions = {}): Promise<KbResult<KbGraph>> {
	const p = new URLSearchParams();
	if (opts.domain) p.set("domain", opts.domain);
	for (const k of ["archivedWork", "wikilinks", "denTopics"] as const) {
		if (opts[k] !== undefined) p.set(k, opts[k] ? "1" : "0");
	}
	const q = p.size ? `?${p}` : "";
	return request(`/api/wolves/${seg(librarian)}/kb/graph${q}`);
}

export function fetchKbEntry(librarian: string, id: string): Promise<KbResult<KbEntryDetail>> {
	return request(`/api/wolves/${seg(librarian)}/kb/entries/${seg(id)}`);
}

export function postConsolidate(wolf: string): Promise<KbResult<ConsolidateResponse>> {
	return request(`/api/wolves/${seg(wolf)}/memory/consolidate`, { method: "POST" });
}

export function postPromote(wolf: string): Promise<KbResult<PromoteResponse>> {
	return request(`/api/wolves/${seg(wolf)}/memory/promote`, { method: "POST" });
}
