import { redirect } from "next/navigation";
import { threadHref } from "@/src/core";
import { getConsoleClient } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * "+ New session" (sidebar, ⌘N): the ConsoleClient cannot create threads yet,
 * so the affordance NOOPS INTO the first wolf's first thread — the mock's
 * home thread — rather than cloning the fixture. When the client grows
 * thread creation, this is the one place that calls it.
 */
export default async function NewSessionPage() {
	const client = getConsoleClient();
	const [wolf] = await client.listWolves();
	const [thread] = wolf ? await client.listThreads(wolf.name) : [];
	redirect(wolf && thread ? threadHref(wolf.name, thread.id) : "/");
}
