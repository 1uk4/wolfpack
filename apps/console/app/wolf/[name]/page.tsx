import { notFound, redirect } from "next/navigation";
import { threadHref } from "@/src/core";
import { getConsoleClient, isNotFound } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * /wolf/<name> has no page of its own: it lands in the wolf's Home thread. A wolf without one gets one created here
 * (owner decision, work-wolfpack-i2hZIv9). Creation is `createThread({kind:"home"})`, the call the wolf itself makes
 * idempotent (an existing Home is returned unchanged, never a second), so concurrent visits cannot create two.
 * An unknown wolf is a 404.
 */
export default async function WolfPage({ params }: { params: Promise<{ name: string }> }) {
	const { name } = await params;
	const client = getConsoleClient();
	const threads = await client.listThreads(name).catch((err) => {
		if (isNotFound(err)) return null;
		throw err;
	});
	if (!threads) notFound();
	let home = threads.find((t) => t.kind === "home");
	if (!home) {
		if (!client.createThread) throw new Error(`wolf ${name} has no Home thread and this client cannot create one`);
		home = await client.createThread(name, { kind: "home" });
	}
	redirect(threadHref(name, home.id));
}
