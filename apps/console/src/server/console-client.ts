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

/** Build a client from the environment (exported for tests; no singleton). */
export function createConsoleClient(env: Record<string, string | undefined> = process.env): ConsoleClient {
	const baseUrl = env.WOLFPACK_API_URL?.trim();
	return baseUrl ? new HttpConsoleClient({ baseUrl }) : new MockConsoleClient();
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
