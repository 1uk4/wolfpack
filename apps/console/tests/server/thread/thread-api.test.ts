/**
 * The thread API handlers (what the /api/wolves route files wrap), driven
 * against the @wolfpack/client mock: the SSE endpoint replays with
 * Last-Event-ID, follows live, and ends at turn-end.
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { MockConsoleClient, FIXTURE_THREAD } from "@wolfpack/client";
import { createThreadApi, resumeCursor } from "../../../src/server/thread/thread-api.ts";
import { createConsoleClient, getConsoleClient, setConsoleClient } from "../../../src/server/thread/console-client.ts";
import { HUB_AUTH_HEADER } from "../../../src/core/ui/hub-auth.ts";

const ref = { wolf: "1uk4", slug: "home" };

interface Frame {
	id?: number;
	data: string;
}

async function frames(res: Response): Promise<Frame[]> {
	const text = await res.text();
	return text
		.split("\n\n")
		.filter(Boolean)
		.map((chunk) => {
			const lines = chunk.split("\n");
			const id = lines.find((l) => l.startsWith("id: "));
			return { id: id ? Number(id.slice(4)) : undefined, data: lines.find((l) => l.startsWith("data: "))!.slice(6) };
		});
}

const stream = (api: ReturnType<typeof createThreadApi>, headers: Record<string, string> = {}, query = "") =>
	api.stream(ref, new Request(`http://t/stream${query}`, { headers }));

describe("thread API: SSE stream", () => {
	it("streams the scripted turn through turn-end, framed with event ids, then [DONE]", async () => {
		const client = new MockConsoleClient({ delayMs: 0 });
		const api = createThreadApi(() => client);
		await client.submit(FIXTURE_THREAD.id, "go");
		const res = await stream(api);
		assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
		const got = await frames(res);
		assert.equal(got.at(-1)!.data, "[DONE]");
		const events = got.slice(0, -1).map((f) => JSON.parse(f.data) as { id: number; type: string });
		assert.equal(events[0]!.type, "turn-start");
		assert.equal(events.at(-1)!.type, "turn-end");
		assert.deepEqual(got.slice(0, -1).map((f) => f.id), events.map((e) => e.id));
	});

	it("follows a live turn (attached before it ends)", async () => {
		const client = new MockConsoleClient({ delayMs: 5 });
		const api = createThreadApi(() => client);
		await client.submit(FIXTURE_THREAD.id, "go");
		const got = await frames(await stream(api)); // returns only when turn-end arrived
		assert.equal(JSON.parse(got.at(-2)!.data).type, "turn-end");
	});

	it("replays only id > Last-Event-ID", async () => {
		const client = new MockConsoleClient({ delayMs: 0 });
		const api = createThreadApi(() => client);
		await client.submit(FIXTURE_THREAD.id, "go");
		const all = (await frames(await stream(api))).slice(0, -1);
		const cut = all[3]!.id!;
		const resumed = (await frames(await stream(api, { "Last-Event-ID": String(cut) }))).slice(0, -1);
		assert.deepEqual(resumed.map((f) => f.id), all.filter((f) => f.id! > cut).map((f) => f.id));
		assert.ok(resumed.length > 0 && resumed[0]!.id === cut + 1);
	});

	it("resumes mid-turn: cut a live stream, reconnect with the last seen id, get the rest", async () => {
		const client = new MockConsoleClient({ delayMs: 5 });
		const api = createThreadApi(() => client);
		await client.submit(FIXTURE_THREAD.id, "go");
		const res = await stream(api);
		const reader = res.body!.getReader();
		const dec = new TextDecoder();
		const seen: number[] = [];
		let buf = "";
		while (seen.length < 3) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += dec.decode(value);
			for (const m of buf.matchAll(/^id: (\d+)$/gm)) if (!seen.includes(Number(m[1]))) seen.push(Number(m[1]));
		}
		await reader.cancel(); // the connection drops
		const last = seen.at(-1)!;
		const rest = (await frames(await stream(api, { "Last-Event-ID": String(last) }))).slice(0, -1);
		assert.equal(rest[0]!.id, last + 1);
		assert.equal(JSON.parse(rest.at(-1)!.data).type, "turn-end");
		const ids = rest.map((f) => f.id!);
		assert.deepEqual(ids, ids.map((_, i) => last + 1 + i), "contiguous, no gaps or repeats");
	});

	it("sends a ': ka' comment every 15s while the wolf is silent, so the browser connection stays warm", async (t) => {
		t.after(() => mock.timers.reset());
		mock.timers.enable({ apis: ["setInterval"] });
		const client = {
			listThreads: async () => [FIXTURE_THREAD],
			// Never yields: an idle turn.
			watch: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}), return: async () => ({ done: true, value: undefined }) }) }),
		};
		const api = createThreadApi(() => client as never);
		const res = await stream(api);
		const reader = res.body!.getReader();
		mock.timers.tick(15_000);
		const { value } = await reader.read();
		assert.equal(new TextDecoder().decode(value), ": ka\n\n");
		await reader.cancel();
	});

	it("aborting the request closes the watch and stops the keepalive, even if the body is never cancelled", async (t) => {
		t.after(() => mock.timers.reset());
		mock.timers.enable({ apis: ["setInterval"] });
		let closed = false;
		const client = {
			listThreads: async () => [FIXTURE_THREAD],
			watch: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}), return: async () => ((closed = true), { done: true, value: undefined }) }) }),
		};
		const abort = new AbortController();
		await createThreadApi(() => client as never).stream(ref, new Request("http://t/stream", { signal: abort.signal }));
		abort.abort();
		assert.equal(closed, true);
	});

	it("an idle thread with nothing to replay ends immediately", async () => {
		const api = createThreadApi(() => new MockConsoleClient({ delayMs: 0 }));
		assert.deepEqual(await frames(await stream(api)), [{ id: undefined, data: "[DONE]" }]);
	});

	it("?from= is honoured; junk cursors are ignored", () => {
		assert.equal(resumeCursor(new Request("http://t/s?from=7")), 7);
		assert.equal(resumeCursor(new Request("http://t/s", { headers: { "last-event-id": "4" } })), 4);
		assert.equal(resumeCursor(new Request("http://t/s?from=abc")), undefined);
		assert.equal(resumeCursor(new Request("http://t/s?from=-1")), undefined);
		assert.equal(resumeCursor(new Request("http://t/s")), undefined);
	});

	it("404s an unknown thread or wolf", async () => {
		const api = createThreadApi(() => new MockConsoleClient({ delayMs: 0 }));
		assert.equal((await api.stream({ wolf: "1uk4", slug: "nope" }, new Request("http://t/s"))).status, 404);
		assert.equal((await api.stream({ wolf: "ghost", slug: "home" }, new Request("http://t/s"))).status, 404);
	});
});

describe("thread API: reads and commands", () => {
	it("the threads list asks the client for the settled subagents only when `all` is set", async () => {
		const asked: unknown[] = [];
		const client = { listThreads: async (_wolf: string, opts?: unknown) => (asked.push(opts), []) };
		const api = createThreadApi(() => client as never);
		await api.threads("1uk4");
		await api.threads("1uk4", { all: true });
		assert.deepEqual(asked, [undefined, { all: true }]);
	});

	it("the default threads list carries only what the sidebar draws: workspace shrinks to its branch; `all` keeps the full summary", async () => {
		const full = { id: "1uk4/home", wolf: "1uk4", kind: "home", title: "Home", workspace: { repo: "wolfpack", toplevel: "/r", path: "/r", base: "main", branch: "wolf/1uk4", isWorktree: false } };
		const api = createThreadApi(() => ({ listThreads: async () => [full] }) as never);
		const trimmed = (await (await api.threads("1uk4")).json()) as { threads: unknown[] };
		assert.deepEqual(trimmed.threads, [{ ...full, workspace: { branch: "wolf/1uk4" } }]);
		const all = (await (await api.threads("1uk4", { all: true })).json()) as { threads: unknown[] };
		assert.deepEqual(all.threads, [full]);
	});

	it("the children list asks the client for the settled subagents only when `all` is set", async () => {
		const asked: unknown[] = [];
		const client = {
			listThreads: async () => [{ id: "1uk4/home", wolf: "1uk4", kind: "home", title: "Home" }],
			listChildren: async (_id: string, opts?: unknown) => (asked.push(opts), []),
		};
		const api = createThreadApi(() => client as never);
		await api.children(ref);
		await api.children(ref, { all: true });
		assert.deepEqual(asked, [undefined, { all: true }]);
	});

	it("lists wolves and threads, serves thread detail by slug", async () => {
		const api = createThreadApi(() => new MockConsoleClient({ delayMs: 0 }));
		assert.deepEqual(((await (await api.wolves()).json()) as { wolves: { name: string }[] }).wolves.map((w) => w.name), ["1uk4"]);
		assert.deepEqual(((await (await api.threads("1uk4")).json()) as { threads: { id: string }[] }).threads.map((t) => t.id), ["1uk4/home"]);
		const detail = (await (await api.thread(ref)).json()) as { id: string; busy: boolean };
		assert.equal(detail.id, "1uk4/home");
		assert.equal(detail.busy, false);
	});

	it("submit acks, rejects a second while busy (409), validates input; abort ends the turn", async () => {
		const client = new MockConsoleClient({ delayMs: 20 });
		const api = createThreadApi(() => client);
		const post = (body: unknown) =>
			api.submit(ref, new Request("http://t/submit", { method: "POST", body: JSON.stringify(body) }));
		assert.equal((await post({})).status, 400);
		const ack = await post({ input: "hi" });
		assert.equal(ack.status, 200);
		assert.equal(((await ack.json()) as { disposition: string }).disposition, "started");
		const busy = await post({ input: "again" });
		assert.equal(busy.status, 409);
		assert.equal(((await busy.json()) as { code: string }).code, "busy");
		assert.equal((await api.abort(ref)).status, 200);
		const got = await frames(await stream(api));
		assert.equal(JSON.parse(got.at(-2)!.data).reason, "aborted");
	});
});

describe("thread API: close, reopen, remove", () => {
	it("closes a thread, reopens it, and refuses to remove it while open (409 thread_open)", async () => {
		const client = new MockConsoleClient({ delayMs: 0 });
		const api = createThreadApi(() => client);
		const closed = await api.close(ref);
		assert.equal(closed.status, 200);
		assert.deepEqual(await closed.json(), { closed: true, closedReason: "Closed by you" });
		assert.equal(((await (await api.thread(ref)).json()) as { closed?: boolean }).closed, true);
		const reopened = await api.reopen(ref);
		assert.deepEqual(await reopened.json(), { closed: false });
		const open = await api.remove(ref);
		assert.equal(open.status, 409);
		assert.equal(((await open.json()) as { code: string }).code, "thread_open");
	});

	it("removes a closed thread, then 404s it; answers 501 when the client cannot", async () => {
		const client = new MockConsoleClient({ delayMs: 0 });
		const api = createThreadApi(() => client);
		await api.close(ref);
		assert.deepEqual(await (await api.remove(ref)).json(), { removed: true });
		assert.equal((await api.thread(ref)).status, 404);
		const bare = createThreadApi(() => ({ listThreads: async () => [{ id: "1uk4/home", wolf: "1uk4", kind: "home", title: "Home" }] }) as never);
		assert.equal((await bare.close(ref)).status, 501);
	});
});

describe("console client factory", () => {
	it("is a process singleton (a turn started in one request is visible to the next)", async () => {
		setConsoleClient(undefined);
		const a = getConsoleClient();
		assert.equal(getConsoleClient(), a);
		await a.submit(FIXTURE_THREAD.id, "go");
		assert.equal((await getConsoleClient().getThread(FIXTURE_THREAD.id)).busy, true);
		await a.abort(FIXTURE_THREAD.id);
		setConsoleClient(undefined);
	});
});

describe("error matching", () => {
  it("matches client errors by name, so duplicated module copies still map to 404/409", async () => {
    class NotFoundError extends Error { constructor() { super("x"); this.name = "NotFoundError"; } }
    class BusyError extends Error { constructor() { super("y"); this.name = "BusyError"; } }
    const foreign = {
      listThreads: async () => { throw new NotFoundError(); },
      submit: async () => { throw new BusyError(); },
      getThread: async () => { throw new NotFoundError(); },
    } as unknown as import("@wolfpack/client").ConsoleClient;
    const api = createThreadApi(() => foreign);
    assert.equal((await api.threads("w")).status, 404);
    const known = { ...foreign, listThreads: async () => [{ id: "1uk4/home" }] } as unknown as typeof foreign;
    const post = createThreadApi(() => known).submit(ref, new Request("http://t", { method: "POST", body: JSON.stringify({ input: "a" }) }));
    assert.equal((await post).status, 409);
  });
});

describe("console client factory env switch", () => {
	it("returns an HttpConsoleClient when WOLFPACK_API_URL is set, the mock otherwise", async () => {
		const { createConsoleClient } = await import("../../../src/server/thread/console-client.ts");
		const { HttpConsoleClient } = await import("@wolfpack/client");
		assert.ok(createConsoleClient({ WOLFPACK_API_URL: "http://127.0.0.1:1" }) instanceof HttpConsoleClient);
		assert.ok(createConsoleClient({}) instanceof MockConsoleClient);
		assert.ok(createConsoleClient({ WOLFPACK_API_URL: "  " }) instanceof MockConsoleClient);
	});
});

describe("thread API: snapshot frames", () => {
	it("forwards a mid-turn snapshot as a `snapshot` frame, in order, and the adapter ends with the corrected text", async () => {
		const { ThreadEventAdapter } = await import("../../../src/core/index.ts");
		const env = { threadId: "1uk4/home", at: "2026-01-01T00:00:00.000Z", actor: { id: "w", kind: "wolf" } };
		const snap = {
			...env, id: 2, type: "snapshot", upToId: 2,
			inFlight: { turnId: "t1", text: "HEAD-the full text" },
			thread: { id: "1uk4/home", wolf: "1uk4", kind: "home", title: "home", busy: true, lastEventId: 2, messages: [] },
		};
		const client = {
			listThreads: async () => [{ id: "1uk4/home" }],
			async *watch(_id: string, opts: { onSnapshot?: (s: unknown) => void }) {
				yield { ...env, id: 1, type: "turn-start", turnId: "t1" };
				yield { ...env, id: 2, type: "text-delta", turnId: "t1", text: "stale partial" };
				opts.onSnapshot?.(snap);
				yield { ...env, id: 3, type: "turn-end", turnId: "t1", reason: "complete" };
			},
		} as unknown as import("@wolfpack/client").ConsoleClient;
		const got = await frames(await createThreadApi(() => client).stream(ref, new Request("http://t/stream")));
		const events = got.slice(0, -1).map((f) => JSON.parse(f.data));
		assert.deepEqual(events.map((e) => e.type), ["turn-start", "text-delta", "snapshot", "turn-end"]);
		const adapter = new ThreadEventAdapter();
		const wire = events.flatMap((e) => adapter.apply(e));
		const end = wire.find((w) => w.type === "message_end") as unknown as { message: { content: Array<{ text: string }> } };
		assert.equal(end.message.content[0]?.text, "HEAD-the full text");
	});
});

describe("frame file proxy", () => {
	const named = (name: string, code?: string) => Object.assign(new Error("refused"), { name, ...(code ? { code } : {}) });
	const withFrames = (getFrameFile: (wolf: string, path: string) => Promise<{ bytes: Uint8Array; mimeType: string }>) =>
		createThreadApi(() => Object.assign(new MockConsoleClient({ delayMs: 0 }), { getFrameFile }));

	it("relays the wolf's html sandboxed and uncached, and maps its refusals to 400/403/404/413", async () => {
		const html = new TextEncoder().encode("<p>hi</p>");
		const ok = await withFrames(async () => ({ bytes: html, mimeType: "text/html; charset=utf-8" })).frameFile("1uk4", "a.html");
		assert.equal(ok.status, 200);
		assert.equal(await ok.text(), "<p>hi</p>");
		assert.equal(ok.headers.get("content-type"), "text/html; charset=utf-8");
		assert.equal(ok.headers.get("content-security-policy"), "sandbox");
		assert.equal(ok.headers.get("cache-control"), "no-store");
		assert.equal(ok.headers.get("x-content-type-options"), "nosniff");

		const status = async (err: Error) =>
			(await withFrames(async () => { throw err; }).frameFile("1uk4", "a.html")).status;
		assert.equal(await status(named("NotFoundError")), 404);
		assert.equal(await status(named("ProtocolError", "forbidden")), 403);
		assert.equal(await status(named("ProtocolError", "too_large")), 413);
		assert.equal(await status(named("ProtocolError", "invalid_request")), 400);
		assert.equal((await withFrames(async () => ({ bytes: html, mimeType: "" })).frameFile("1uk4", null)).status, 400);
	});

	it("tells a host that has no frame route (404 'no route' / 'no such path') from a missing file (404 'no such frame file')", async () => {
		const answer = async (message: string) => {
			const res = await withFrames(async () => { throw Object.assign(new Error(message), { name: "NotFoundError" }); }).frameFile("hal", "progress.html");
			return { status: res.status, code: ((await res.json()) as { code?: string }).code };
		};
		assert.deepEqual(await answer("no route /v1/wolves/hal/frame-file"), { status: 404, code: "host_outdated" });
		assert.deepEqual(await answer("no such path: /v1/wolves/hal/frame-file"), { status: 404, code: "host_outdated" });
		assert.deepEqual(await answer("no such frame file"), { status: 404, code: undefined });
	});

	it("keeps the 403/413 mapping local: another route still answers forbidden and too_large with 500", async () => {
		const other = (code: string) =>
			createThreadApi(() =>
				Object.assign(new MockConsoleClient({ delayMs: 0 }), {
					getThreadSettings: async () => ({}),
					listThreads: async () => { throw named("ProtocolError", code); },
				}),
			).getSettings({ wolf: "1uk4", slug: "x" });
		assert.equal((await other("forbidden")).status, 500);
		assert.equal((await other("too_large")).status, 500);
	});
});

describe("hub-auth failures (relay mode, unpaired or revoked browser)", () => {
	// The relay client throws HubAuthError when the request has no (valid) bearer: a plain route and the SSE route must answer 401 + the marker,
	// and the SSE route must do it BEFORE a stream opens (it resolves the thread first, which fails first).
	const unpaired = () => createConsoleClient({ WOLFPACK_HUB_URL: "http://127.0.0.1:1" }, async () => null);
	const api = () => createThreadApi(unpaired);
	const assert401 = (res: Response) => {
		assert.equal(res.status, 401);
		assert.equal(res.headers.get(HUB_AUTH_HEADER), "required");
		assert.equal(res.headers.get("content-type")?.startsWith("application/json"), true);
	};
	it("a plain route (wolves, threads)", async () => {
		assert401(await api().wolves());
		assert401(await api().threads("1uk4"));
	});
	it("the stream route answers 401 as a normal response, not an opened event stream", async () => {
		const res = await api().stream(ref, new Request("http://x/api/wolves/1uk4/threads/home/stream"));
		assert401(res);
		assert.notEqual(res.headers.get("content-type"), "text/event-stream");
	});
});
