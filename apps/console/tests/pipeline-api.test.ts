import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProtocolError, type ConsoleClient } from "@wolfpack/client";
import { createPipelineApi } from "../src/server/pipeline-api.ts";

const stub = (p: Record<string, unknown>) => () => p as unknown as ConsoleClient;

describe("pipeline API", () => {
	it("200 passes the response through", async () => {
		const calls: string[] = [];
		const api = createPipelineApi(stub({ getKbPipeline: async (w: string) => (calls.push(w), { lanes: [], receipts: [], parked: [], sweep: {} }) }));
		const res = await api.kbPipeline("dewey");
		assert.equal(res.status, 200);
		assert.deepEqual(calls, ["dewey"]);
		assert.deepEqual((await res.json()).lanes, []);
	});
	it("kb_unavailable → 409", async () => {
		const api = createPipelineApi(stub({ getKbPipeline: async () => { throw new ProtocolError("kb_unavailable", "not a librarian", false); } }));
		const res = await api.kbPipeline("x");
		assert.equal(res.status, 409);
		assert.equal((await res.json()).code, "kb_unavailable");
	});
	it("missing method → 409", async () => {
		const res = await createPipelineApi(stub({})).kbPipeline("x");
		assert.equal(res.status, 409);
	});
});
