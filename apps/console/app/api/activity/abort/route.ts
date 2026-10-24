/**
 * POST /api/activity/abort — the dock's END/ABORT control, uniform across
 * process kinds (user-decided contract): body {kind: "job"|"turn", id}
 * where id is the jobId for jobs and the chatId for turns
 * (background-turn wave, 2026-09-25: a running turn is a background
 * object — any client may stop it here; a view leaving NEVER kills it).
 * Mechanisms live in their domains — abortJob (server/jobs.ts) and
 * abortTurn (server/turn-runs.ts, the running-turn registry); this route
 * is the thin composition.
 *
 * Outcomes: a job's not_found -> 404, not_running -> 409, aborted -> 200.
 * A turn mirrors the job semantics: not_running -> 409 (honest "nothing to
 * abort" — the caller refetches), aborted -> 200 (partial persists via
 * the usual settle path, every subscriber closes cleanly).
 */
import { abortJob, abortTurn } from "@/src/server";

export async function POST(req: Request) {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const { kind, id } = (body ?? {}) as { kind?: string; id?: string };
	if ((kind !== "job" && kind !== "turn") || typeof id !== "string" || id === "") {
		return Response.json({ error: 'Body must be {kind: "job"|"turn", id: string}' }, { status: 400 });
	}
	if (!/^[A-Za-z0-9:_-]+$/.test(id)) {
		return Response.json({ error: "Invalid id" }, { status: 400 });
	}

	if (kind === "job") {
		const outcome = abortJob(id);
		if (!outcome.ok) {
			const status = outcome.reason === "not_found" ? 404 : 409;
			return Response.json({ ok: false, reason: outcome.reason }, { status });
		}
		return Response.json({ ok: true });
	}
	const outcome = abortTurn(id);
	if (!outcome.ok) return Response.json({ ok: false, reason: outcome.reason }, { status: 409 });
	return Response.json({ ok: true });
}
