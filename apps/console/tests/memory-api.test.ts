/**
 * The memory/KB API handlers (what the /api/wolves/[name]/… route files
 * wrap), driven against a stub ConsoleClient: pass-through, query mapping,
 * ProtocolError code → HTTP status, and the SSE bridge.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NotFoundError, ProtocolError, type ConsoleClient, type MemoryEvent } from "@wolfpack/client";
import { FIRST_PULL_MS, createMemoryApi } from "../src/server/memory-api.ts";

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

	it("memoryTopic passes a valid scope", async () => {
		const calls: unknown[][] = [];
		const api = createMemoryApi(stub({ getMemoryTopic: async (...a: unknown[]) => (calls.push(a), { id: "x" }) }));
		await api.memoryTopic("w", "x", "den");
		await api.memoryTopic("w", "x");
		assert.deepEqual(calls[0], ["w", "x", { scope: "den" }]);
		assert.deepEqual(calls[1], ["w", "x", {}]);
	});

	it("memoryObservations passes a valid limit, rejects a bad one", async () => {
		const calls: unknown[][] = [];
		const api = createMemoryApi(stub({ getMemoryObservations: async (...a: unknown[]) => (calls.push(a), { observations: [], total: 0 }) }));
		await api.memoryObservations("w", "5");
		await api.memoryObservations("w");
		assert.deepEqual(calls, [["w", { limit: 5 }], ["w", {}]]);
		const bad = await api.memoryObservations("w", "0");
		assert.equal(bad.status, 400);
		assert.equal((await body(bad)).code, "invalid_request");
		assert.equal((await createMemoryApi(stub({})).memoryObservations("w")).status, 409);
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

	it("workList passes the domain and graduated flag, and needs a domain", async () => {
		const calls: unknown[][] = [];
		const api = createMemoryApi(stub({ listWork: async (...a: unknown[]) => (calls.push(a), { items: [] }) }));
		assert.deepEqual(await body(await api.workList("a", "wolfpack", true)), { items: [] });
		assert.deepEqual(calls[0], ["a", { domain: "wolfpack", graduated: true }]);
		assert.equal((await api.workList("a", null, false)).status, 400);
		assert.equal((await createMemoryApi(stub({})).workList("a", "d", false)).status, 409);
	});

	it("kbGraph maps query params to options", async () => {
		const calls: unknown[][] = [];
		const api = createMemoryApi(stub({ getKbGraph: async (...a: unknown[]) => (calls.push(a), { nodes: [] }) }));
		await api.kbGraph("lib", new URLSearchParams("domain=wolfpack&archivedWork=1&denTopics=true"));
		assert.deepEqual(calls[0], ["lib", { domain: "wolfpack", archivedWork: true, denTopics: true }]);
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
		assert.equal((await api.events("w", new Request("http://t/e"))).status, 409);
	});
});

describe("memory API: topic scope", () => {
	it("an invalid scope is a 400", async () => {
		const api = createMemoryApi(stub({ getMemoryTopic: async () => ({}) }));
		const res = await api.memoryTopic("w", "x", "bogus");
		assert.equal(res.status, 400);
		assert.equal((await body(res)).code, "invalid_request");
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
		const res = await api.events("w", new Request("http://t/e"));
		assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
		const text = await res.text();
		const frames = text.split("\n\n").filter((f) => f.startsWith("data: "));
		assert.deepEqual(
			frames.map((f) => (JSON.parse(f.slice(6)) as { jobId: string }).jobId),
			["j1", "j2"],
		);
	});

	it("watchMemory failing immediately → mapped non-200 (409 memory_unavailable)", async () => {
		const api = createMemoryApi(
			stub({
				async *watchMemory() {
					throw new ProtocolError("memory_unavailable", "inert", false);
				},
			}),
		);
		const res = await api.events("w", new Request("http://t/e"));
		assert.equal(res.status, 409);
		assert.equal((await body(res)).code, "memory_unavailable");
	});

	it("a mid-stream error ends with a terminal event: error frame", async () => {
		const api = createMemoryApi(
			stub({
				async *watchMemory() {
					yield ev(1);
					await new Promise((r) => setTimeout(r, FIRST_PULL_MS + 50));
					throw new ProtocolError("engine_error", "lost", true);
				},
			}),
		);
		const text = await (await api.events("w", new Request("http://t/e"))).text();
		assert.match(text, /data: \{.*"jobId":"j1"/);
		assert.match(text, /event: error\ndata: \{"code":"engine_error","message":"lost"\}\n\n$/);
	});

	it("an already-aborted request opens no watch", async () => {
		let watched = false;
		const api = createMemoryApi(stub({ async *watchMemory() { watched = true; } }));
		const ac = new AbortController();
		ac.abort();
		const res = await api.events("w", new Request("http://t/e", { signal: ac.signal }));
		assert.equal(res.status, 204);
		assert.equal(watched, false);
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
		const res = await api.events("w", new Request("http://t/e"));
		const reader = res.body!.getReader();
		await reader.read(); // ": open"
		await reader.read(); // first event
		await reader.cancel();
		assert.equal(aborted, true);
	});
});
