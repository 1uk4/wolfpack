/** Transcript paging in the session model: the newest page seeds the view, "Show earlier" prepends, syncs keep it. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionModel } from "../components/session-core.ts";
import { threadTransport, THREAD_PAGE_SIZE } from "../components/thread-transport.ts";
import { createThreadApi } from "../src/server/thread-api.ts";
import { threadMessagesToNative } from "../src/core/index.ts";
import type { ThreadMessage } from "@wolfpack/client";

const msg = (i: number): ThreadMessage => ({ id: `m${i}`, role: i % 2 ? "assistant" : "user", text: `text ${i}`, at: "2026-10-29T00:00:00Z" });
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => msg(from + i));
const native = (ms: ThreadMessage[]) => threadMessagesToNative(ms);
const ids = (m: SessionModel) => m.getState().nativeMessages.map((x) => (x as { id?: string }).id);

function pagedFetch(total: number, urls: string[]): typeof fetch {
	return (async (url: string) => {
		urls.push(url);
		const u = new URL(url, "http://t");
		const limit = Number(u.searchParams.get("limit"));
		const before = u.searchParams.get("before");
		const end = before ? Number(before.slice(1)) : total;
		const start = Math.max(0, end - limit);
		return Response.json({ messages: range(start, end), hasMore: start > 0, cursor: `m${start}`, busy: false });
	}) as typeof fetch;
}

describe("transcript paging", () => {
	it("opens on the initial page only; Show earlier prepends the next older page", async () => {
		const urls: string[] = [];
		const transport = threadTransport("w", "home");
		const m = new SessionModel({ chatId: "c", initialMessages: native(range(70, 120)), initialHasMore: true, transport, fetch: pagedFetch(120, urls) });
		assert.equal(m.getState().nativeMessages.length, 50);
		assert.equal(m.getState().hasMore, true);
		const added = await m.loadEarlier();
		assert.equal(added, 50);
		assert.deepEqual(ids(m).slice(0, 2), ["m20", "m21"]);
		assert.equal(ids(m).length, 100);
		assert.match(urls[0]!, /\?limit=50&before=m70$/);
		assert.equal(m.getState().hasMore, true);
		assert.equal(await m.loadEarlier(), 20);
		assert.equal(m.getState().hasMore, false);
		assert.equal(await m.loadEarlier(), 0);
	});

	it("a settle sync with the newest page keeps the paged-in history and shows new messages", async () => {
		const m = new SessionModel({ chatId: "c", initialMessages: native(range(70, 120)), initialHasMore: true, transport: threadTransport("w", "home"), fetch: pagedFetch(120, []) });
		await m.loadEarlier();
		// two new messages landed; the newest page now starts at 72
		m.setMessages(native(range(72, 122)));
		assert.equal(ids(m).length, 102);
		assert.equal(ids(m)[0], "m20");
		assert.equal(ids(m).at(-1), "m121");
		assert.equal(new Set(ids(m)).size, 102);
	});

	it("adoptRecord accepts a paged record that only appends", () => {
		const m = new SessionModel({ chatId: "c", initialMessages: native(range(70, 120)), initialHasMore: true, transport: threadTransport("w", "home"), fetch: pagedFetch(120, []) });
		m.adoptRecord(native(range(71, 121)));
		assert.equal(ids(m).length, 51);
		assert.equal(ids(m).at(-1), "m120");
	});

	it("a transport without paging never loads earlier", async () => {
		const m = new SessionModel({ chatId: "c", initialMessages: native(range(0, 3)), initialHasMore: true });
		assert.equal(await m.loadEarlier(), 0);
	});

	it("the record URL is the newest page, so a settle never refetches the whole transcript", () => {
		assert.match(threadTransport("w", "home").recordUrl, new RegExp(`\\?limit=${THREAD_PAGE_SIZE}$`));
	});

	it("the API passes limit/before through to the client", async () => {
		const seen: unknown[] = [];
		const client = {
			listThreads: async () => [{ id: "w/home", kind: "home" }],
			getThread: async (_id: string, opts: unknown) => (seen.push(opts), { id: "w/home", messages: [], busy: false }),
		};
		const api = createThreadApi(() => client as never);
		await api.thread({ wolf: "w", slug: "home" }, { limit: 50, before: "m9" });
		assert.deepEqual(seen, [{ limit: 50, before: "m9" }]);
	});
});
