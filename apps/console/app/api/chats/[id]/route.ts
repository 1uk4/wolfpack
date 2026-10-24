import { compactionInFlight, deleteChatSession, getChat, isTurnRunning, stores } from "@/src/server";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
	// turnInFlight lets a returning client re-attach to a running turn
	// (chat-handler write-ahead + registry — see src/server/turn-liveness.ts).
	// Wave D (owner-approved 2026-09-26): the record's messages are native
	// agent history, served VERBATIM — the client derives its view
	// (core/view.ts projectView). turnInFlight lets a returning client
	// re-attach to a running turn;.
	return Response.json({
		...chat,
		messages: chat.messages,
		turnInFlight: isTurnRunning(id),
		compacting: compactionInFlight(id),
	});
}

/**
 * Rename (2026-09-17): the header's click-to-edit title commits here.
 * Validation is a single rule — a non-empty string after trim (the store's
 * "Untitled session" floor is never reached from this route). updatedAt is
 * deliberately NOT bumped: a rename must not reorder the sidebar (same
 * rule as the settings PUT).
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const body = (await req.json().catch(() => null)) as { title?: unknown } | null;
	if (typeof body?.title !== "string" || body.title.trim() === "") {
		return Response.json({ error: "title must be a non-empty string" }, { status: 400 });
	}
	const title = body.title.trim();
	const record = stores.chatStore.renameChat(id, title);
	return Response.json({ title: record.title });
}

/**
 * DELETE /api/chats/[id] — session deletion. Gates are the server
 * orchestration's (server/chats.ts deleteChatSession): 409 while a turn or
 * background job is running — retryable.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const outcome = await deleteChatSession(id);
	if (!outcome.ok) {
		return Response.json(
			{
				error: outcome.error,
				code: outcome.code,
				...("jobIds" in outcome ? { jobIds: outcome.jobIds } : {}),
			},
			{ status: outcome.status },
		);
	}
	return Response.json({ ok: true, jobsRemoved: outcome.jobsRemoved });
}
