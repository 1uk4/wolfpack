import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProtocolError, type ConsoleClient } from "@wolfpack/client";
import { createPromptsApi } from "../src/server/prompts-api.ts";

const view = { id: "orchestrator-rules", group: "Orchestrator", label: "Orchestrator rules", editable: true, text: "t", source: "override", etag: "e2" };
const stub = (p: Record<string, unknown>) => () => p as unknown as ConsoleClient;

describe("prompts API", () => {
	it("save passes the text and the browser's If-Match to the client", async () => {
		const calls: unknown[][] = [];
		const api = createPromptsApi(stub({ putPrompt: async (...a: unknown[]) => (calls.push(a), view) }));
		const res = await api.save("hal", "orchestrator-rules", new Request("http://c/x", { method: "PUT", headers: { "If-Match": "e1" }, body: JSON.stringify({ text: "t" }) }));
		assert.equal(res.status, 200);
		assert.deepEqual(calls, [["hal", "orchestrator-rules", "t", "e1"]]);
	});
	it("maps a stale etag to 409 and an oversized text to 413 with the protocol code", async () => {
		const fail = (code: "conflict" | "too_large") => createPromptsApi(stub({ resetPrompt: async () => { throw new ProtocolError(code, "nope", false); } })).reset("hal", "p", new Request("http://c/x", { method: "DELETE" }));
		const stale = await fail("conflict");
		assert.equal(stale.status, 409);
		assert.equal((await stale.json()).code, "conflict");
		assert.equal((await fail("too_large")).status, 413);
	});
	it("answers 503 when the client has no prompts support (mock mode)", async () => {
		assert.equal((await createPromptsApi(stub({})).list("hal")).status, 503);
	});
});
