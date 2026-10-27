import type { ConsoleClient } from "@wolfpack/client";
import { createThreadApi } from "../../src/server/thread-api.ts";

/** A fetch that serves the /api/wolves thread routes straight from the
 *  handlers over `client` — the route files minus Next. */
export function threadFetch(client: ConsoleClient): typeof fetch {
	const api = createThreadApi(() => client);
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const req = new Request(new URL(String(input), "http://console.test"), init);
		const parts = new URL(req.url).pathname.split("/").filter(Boolean).map(decodeURIComponent);
		// api / wolves / :name / threads / :slug / (submit|abort|stream|attachments)?
		const [, , name, , slug, action, attachmentId] = parts;
		if (!name || !slug) return new Response("not found", { status: 404 });
		const ref = { wolf: name, slug };
		if (!action) return api.thread(ref);
		if (action === "submit") return api.submit(ref, req);
		if (action === "attachments") return attachmentId ? api.attachment(ref, attachmentId) : api.upload(ref, req);
		if (action === "children") return api.children(ref);
		if (action === "ledger") return api.ledger(ref);
		if (action === "abort") return api.abort(ref);
		if (action === "stream") return api.stream(ref, req);
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
}
