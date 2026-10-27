/**
 * The memory/KB API handlers (what the /api/wolves/[name]/… route files
 * wrap), driven against a stub ConsoleClient: pass-through, query mapping,
 * ProtocolError code → HTTP status, and the SSE bridge.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NotFoundError, ProtocolError, type ConsoleClient, type MemoryEvent } from "@wolfpack/client";
import { createMemoryApi } from "../src/server/memory-api.ts";

function stub(partial: Record<string, unknown>): () => ConsoleClient {
	return () => partial as unknown as ConsoleClient;
}

const body = async (res: Response) => (await res.json()) as Record<string, unknown>;

describe("memory API: pass-through", () => {
	it("memoryStatus forwards the thread option", async () => {
		const calls: unknown[][] = [];
		const api = createMemoryApi(
			stub({
				getMemoryStatus: async (...a: unknown[]) => {
					calls.push(a);
					return { state: "on" };
				},
			}),
		);
		const res = await api.memoryStatus("1uk4", "t1");
		assert.equal(res.status, 200);
		assert.deepEqual(await body(res), { state: "on" });
		assert.deepEqual(calls[0], ["1uk4", { thread: "t1" }]);
		await api.memoryStatus("1uk4");
		assert.deepEqual(calls[1], ["1uk4", {}]);
	});

	it("memoryTopic passes a valid scope only", async () => {
		const calls: unknown[][] = [];
		const api = createMemoryApi(stub({ getMemoryTopic: async (...a: unknown[]) => (calls.push(a), { id: "x" }) }));
		await api.memoryTopic("w", "x", "den");
		await api.memoryTopic("w", "x", "bogus");
		assert.deepEqual(calls[0], ["w", "x", { scope: "den" }]);
		assert.deepEqual(calls[1], ["w", "x", {}]);
	});

	it("workRecord, consolidate, promote, kbEntry call the client", async () => {
		const api = createMemoryApi(
			stub({
				getWorkRecord: async (w: string, id: string) => ({ w, id }),
				consolidateMemory: async (w: string) => ({ consolidated: w }),
				promoteMemory: async (w: string) => ({ jobId: w }),
				getKbEntry: async (w: string, id: string) => ({ w, id }),
			}),
		);
		assert.deepEqual(await body(await api.workRecord("a", "wk")), { w: "a", id: "wk" });
		assert.deepEqual(await body(await api.consolidate("a")), { consolidated: "a" });
		assert.deepEqual(await body(await api.promote("a")), { jobId: "a" });
		assert.deepEqual(await body(await api.kbEntry("lib", "e1")), { w: "lib", id: "e1" });
	});

	it("kbGraph maps query params to options", async () => {
		const calls: unknown[][] = [];
		const api = createMemoryApi(stub({ getKbGraph: async (...a: unknown[]) => (calls.push(a), { nodes: [] }) }));
		await api.kbGraph("lib", new URLSearchParams("domain=wolfpack&archivedWork=1&wikilinks=0&denTopics=true"));
		assert.deepEqual(calls[0], ["lib", { domain: "wolfpack", archivedWork: true, wikilinks: false, denTopics: true }]);
		await api.kbGraph("lib", new URLSearchParams());
		assert.deepEqual(calls[1], ["lib", {}]);
	});
});

describe("memory API: error mapping", () => {
	const failing = (err: Error) => {
		const reject = async () => {
			throw err;
		};
		return createMemoryApi(
			stub({
				getMemoryStatus: reject,
				consolidateMemory: reject,
				promoteMemory: reject,
				getKbGraph: reject,
				getKbEntry: reject,
			}),
		);
	};

	it("kb_unavailable → 409 with the code", async () => {
		const res = await failing(new ProtocolError("kb_unavailable", "not the librarian", false)).kbGraph("w", new URLSearchParams());
		assert.equal(res.status, 409);
		assert.deepEqual(await body(res), { error: "not the librarian", code: "kb_unavailable" });
	});

	it("memory_unavailable / memory_busy / promote_unavailable → 409", async () => {
		for (const [code, call] of [
			["memory_unavailable", (a: ReturnType<typeof failing>) => a.memoryStatus("w")],
			["memory_busy", (a: ReturnType<typeof failing>) => a.consolidate("w")],
			["promote_unavailable", (a: ReturnType<typeof failing>) => a.promote("w")],
		] as const) {
			const res = await call(failing(new ProtocolError(code, "m", code === "memory_busy")));
			assert.equal(res.status, 409, code);
			assert.equal((await body(res)).code, code);
		}
	});

	it("other codes keep their protocol status; NotFoundError → 404; unknown → 500", async () => {
		assert.equal((await failing(new ProtocolError("invalid_request", "bad", false)).kbEntry("w", "x")).status, 400);
		assert.equal((await failing(new ProtocolError("engine_error", "boom", true)).kbEntry("w", "x")).status, 502);
		const nf = await failing(new NotFoundError("entry x")).kbEntry("w", "x");
		assert.equal(nf.status, 404);
		assert.equal((await body(nf)).code, "not_found");
		assert.equal((await failing(new Error("kaput")).kbEntry("w", "x")).status, 500);
	});

	it("a client without the optional method answers 409 unavailable", async () => {
		const api = createMemoryApi(stub({}));
		const kb = await api.kbGraph("w", new URLSearchParams());
		assert.equal(kb.status, 409);
		assert.equal((await body(kb)).code, "kb_unavailable");
		const mem = await api.memoryStatus("w");
		assert.equal(mem.status, 409);
		assert.equal((await body(mem)).code, "memory_unavailable");
		assert.equal(api.events("w", new Request("http://t/e")).status, 409);
	});
});

describe("memory API: events SSE", () => {
	const ev = (n: number): MemoryEvent => ({
		type: "promote_started",
		wolf: "w",
		timestamp: "2026-10-26T00:00:00.000Z",
		domain: "d",
		target: { kind: "den" },
		jobId: `j${n}`,
	});

	it("bridges watchMemory to data: frames and ends when the stream ends", async () => {
		const api = createMemoryApi(
			stub({
				async *watchMemory(wolf: string) {
					assert.equal(wolf, "w");
					yield ev(1);
					yield ev(2);
				},
			}),
		);
		const res = api.events("w", new Request("http://t/e"));
		assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
		const text = await res.text();
		const frames = text.split("\n\n").filter((f) => f.startsWith("data: "));
		assert.deepEqual(
			frames.map((f) => (JSON.parse(f.slice(6)) as { jobId: string }).jobId),
			["j1", "j2"],
		);
	});

	it("aborts the watch when the consumer cancels", async () => {
		let aborted = false;
		const api = createMemoryApi(
			stub({
				async *watchMemory(_w: string, opts: { signal: AbortSignal }) {
					opts.signal.addEventListener("abort", () => (aborted = true));
					yield ev(1);
					await new Promise(() => {});
				},
			}),
		);
		const res = api.events("w", new Request("http://t/e"));
		const reader = res.body!.getReader();
		await reader.read(); // ": open"
		await reader.read(); // first event
		await reader.cancel();
		assert.equal(aborted, true);
	});
});
