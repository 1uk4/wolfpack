/**
 * THE CONSOLE CLIENT FACTORY: the one place that decides which ConsoleClient
 * implementation the console talks to: an HttpConsoleClient against a real
 * wolf's /v1 when WOLFPACK_API_URL is set, otherwise the MockConsoleClient
 * from @wolfpack/client (the default; tests and offline dev).
 *
 * A process-wide singleton (pinned on globalThis so dev HMR and the separate
 * route bundles share ONE instance): a turn started by one request must be
 * watchable/resumable by the next — the mock's thread state lives inside it.
 */

import { HttpConsoleClient, MockConsoleClient, type ConsoleClient } from "@wolfpack/client";

const KEY = Symbol.for("wolfpack.console.client");

type Holder = { [KEY]?: ConsoleClient };

/**
 * Build a client from the environment (exported for tests; no singleton).
 *
 *   WOLFPACK_API_URL   a wolf's /v1 (otherwise the mock)
 *   WOLFPACK_HUB_URL   a hubd /v1: work reads (list + record) go there instead of the wolf (optional)
 *   WOLFPACK_HUB_KEY   the hub's X-API-Key (optional)
 */
export function createConsoleClient(env: Record<string, string | undefined> = process.env): ConsoleClient {
	const baseUrl = env.WOLFPACK_API_URL?.trim();
	const hubUrl = env.WOLFPACK_HUB_URL?.trim();
	const hub = hubUrl ? { baseUrl: hubUrl, apiKey: env.WOLFPACK_HUB_KEY?.trim() || undefined } : undefined;
	if (baseUrl) return new HttpConsoleClient({ baseUrl, ...(hub ? { hub } : {}) });
	const mock = new MockConsoleClient();
	if (!hub) return mock;
	// No wolf configured, a hub is: threads stay on the mock, work reads come from the hub.
	const hubClient = new HttpConsoleClient({ baseUrl: hub.baseUrl, hub });
	mock.listWork = (wolf, opts) => hubClient.listWork(wolf, opts);
	mock.getWorkRecord = (wolf, id) => hubClient.getWorkRecord(wolf, id);
	return mock;
}

export function getConsoleClient(): ConsoleClient {
	const holder = globalThis as Holder;
	holder[KEY] ??= createConsoleClient();
	return holder[KEY];
}

/** Test seam: replace (or clear, with undefined) the process singleton. */
export function setConsoleClient(client: ConsoleClient | undefined): void {
	(globalThis as Holder)[KEY] = client;
}
