/**
 * THE CONSOLE CLIENT FACTORY: the one place that decides which ConsoleClient
 * implementation the console talks to. Today that is always the
 * MockConsoleClient from @wolfpack/client; the real SDK-backed client
 * replaces the construction here and nothing else changes.
 *
 * A process-wide singleton (pinned on globalThis so dev HMR and the separate
 * route bundles share ONE instance): a turn started by one request must be
 * watchable/resumable by the next — the mock's thread state lives inside it.
 */

import { MockConsoleClient, type ConsoleClient } from "@wolfpack/client";

const KEY = Symbol.for("wolfpack.console.client");

type Holder = { [KEY]?: ConsoleClient };

export function getConsoleClient(): ConsoleClient {
	const holder = globalThis as Holder;
	holder[KEY] ??= new MockConsoleClient();
	return holder[KEY];
}

/** Test seam: replace (or clear, with undefined) the process singleton. */
export function setConsoleClient(client: ConsoleClient | undefined): void {
	(globalThis as Holder)[KEY] = client;
}
