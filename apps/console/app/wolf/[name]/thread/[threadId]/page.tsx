import { notFound } from "next/navigation";
import { cardsOfThread, resolveThreadId, threadLabel, threadMessagesToNative } from "@/src/core";
import { getConsoleClient, isNotFound } from "@/src/server";
import { withHistoryAttachments } from "@/components/attachments";
import { THREAD_PAGE_SIZE } from "@/components/thread-transport";
import { ThreadChat } from "@/components/thread-chat";
import { FEATURE_GRADUATED } from "@/components/thread-closed";

export const dynamic = "force-dynamic";

/**
 * The chat view bound to one thread of one wolf, through the ConsoleClient.
 * `threadId` here is the URL slug (core threadSlug), resolved to the client's
 * id via listThreads. History is seeded from getThread(); a turn already
 * running reattaches through the SSE stream.
 */
export default async function ThreadPage({ params }: { params: Promise<{ name: string; threadId: string }> }) {
	const { name, threadId: slug } = await params;
	const client = getConsoleClient();
	try {
		const threads = await client.listThreads(name);
		const id = resolveThreadId(name, slug, threads);
		if (!id) notFound();
		const wolfColor = (await client.listWolves().catch(() => [])).find((w) => w.name === name)?.color;
		const thread = await client.getThread(id, { limit: THREAD_PAGE_SIZE });
		return (
			<ThreadChat
				key={thread.id}
				wolf={name}
				slug={slug}
				threadId={thread.id}
				title={threadLabel(name, thread)}
				workspace={thread.workspace}
				initialTurnStartedAt={thread.turnStartedAt}
				initialMessages={withHistoryAttachments(threadMessagesToNative(thread.messages), thread.messages)}
				initialHasMore={thread.hasMore}
				initiallyInFlight={thread.busy}
				initialCards={cardsOfThread(thread)}
				parentThreadId={thread.parentThreadId}
				colorThreads={threads.map((t) => ({ id: t.id, kind: t.kind, parentThreadId: t.parentThreadId, settings: t.settings }))}
				wolfColor={wolfColor}
				initialBound={thread.boundItem ?? thread.boundWorkItem}
				closedReason={thread.closed ? (thread.closedReason ?? FEATURE_GRADUATED) : undefined}
			/>
		);
	} catch (err) {
		if (isNotFound(err)) notFound();
		throw err;
	}
}
