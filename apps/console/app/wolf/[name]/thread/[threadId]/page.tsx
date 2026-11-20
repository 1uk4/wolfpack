import { Suspense } from "react";
import { notFound } from "next/navigation";
import { ThreadSkeleton } from "@/components/thread/thread-skeleton";
import { cardsOfThread, resolveThreadId, threadLabel, threadMessagesToNative } from "@/src/core";
import { getConsoleClient, isNotFound } from "@/src/server";
import { withHistoryAttachments } from "@/components/composer/attachments";
import { THREAD_FIRST_PAGE } from "@/components/thread/thread-transport";
import { ThreadChat } from "@/components/thread/thread-chat";
import { FEATURE_GRADUATED } from "@/components/thread/thread-closed";

export const dynamic = "force-dynamic";

/**
 * The chat view bound to one thread of one wolf, through the ConsoleClient.
 * `threadId` here is the URL slug (core threadSlug), resolved to the client's
 * id via listThreads. History is seeded from getThread(); a turn already
 * running reattaches through the SSE stream.
 */
type Params = { params: Promise<{ name: string; threadId: string }> };

/** Paints the frame at once; the transcript streams in when ThreadBody's awaits finish. */
export default function ThreadPage({ params }: Params) {
	return (
		<Suspense fallback={<ThreadSkeleton />}>
			<ThreadBody params={params} />
		</Suspense>
	);
}

async function ThreadBody({ params }: Params) {
	const { name, threadId: slug } = await params;
	const client = getConsoleClient();
	try {
		const [listed, wolves] = await Promise.all([client.listThreads(name), client.listWolves().catch(() => [])]);
		let threads = listed;
		let id = resolveThreadId(name, slug, threads);
		if (!id) {
			// The default list omits settled subagent threads; an old link may still point at one.
			threads = await client.listThreads(name, { all: true });
			id = resolveThreadId(name, slug, threads);
		}
		if (!id) notFound();
		const wolfColor = wolves.find((w) => w.name === name)?.color;
		const thread = await client.getThread(id, { limit: THREAD_FIRST_PAGE });
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
				colorThreads={threads.filter((t) => t.kind !== "subagent").map((t) => ({ id: t.id, kind: t.kind, parentThreadId: t.parentThreadId, settings: t.settings }))}
				wolfColor={wolfColor}
				initialBound={thread.boundItem ?? thread.boundWorkItem}
				kind={thread.kind}
				closedReason={thread.closed ? (thread.closedReason ?? FEATURE_GRADUATED) : undefined}
			/>
		);
	} catch (err) {
		if (isNotFound(err)) notFound();
		throw err;
	}
}
