import { notFound } from "next/navigation";
import { cardsOfThread, resolveThreadId, threadMessagesToNative } from "@/src/core";
import { getConsoleClient, isNotFound } from "@/src/server";
import { withHistoryAttachments } from "@/components/attachments";
import { ThreadChat } from "@/components/thread-chat";

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
		const id = resolveThreadId(name, slug, await client.listThreads(name));
		if (!id) notFound();
		const thread = await client.getThread(id);
		return (
			<ThreadChat
				key={thread.id}
				wolf={name}
				slug={slug}
				threadId={thread.id}
				title={thread.title}
				initialMessages={withHistoryAttachments(threadMessagesToNative(thread.messages), thread.messages)}
				initiallyInFlight={thread.busy}
				initialCards={cardsOfThread(thread)}
				closedReason={thread.closed ? (thread.closedReason ?? "Feature graduated") : undefined}
			/>
		);
	} catch (err) {
		if (isNotFound(err)) notFound();
		throw err;
	}
}
