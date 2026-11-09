import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpConsoleClient, ProtocolError, type ConsoleClient } from "@wolfpack/client";
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
		const fail = (code: "conflict" | "too_large") => createPromptsApi(stub({ resetPrompt: async () => { throw new ProtocolError(code, "nope", false); } })).reset("hal", "p", new Request("http://c/x", { method: "DELETE", headers: { "If-Match": "e1" } }));
		const stale = await fail("conflict");
		assert.equal(stale.status, 409);
		assert.equal((await stale.json()).code, "conflict");
		assert.equal((await fail("too_large")).status, 413);
	});
	it("refuses a save or reset without If-Match (400) before reaching the client", async () => {
		const api = createPromptsApi(stub({ putPrompt: async () => { throw new Error("must not be called"); }, resetPrompt: async () => { throw new Error("must not be called"); } }));
		const saved = await api.save("hal", "p", new Request("http://c/x", { method: "PUT", body: JSON.stringify({ text: "t" }) }));
		assert.equal(saved.status, 400);
		assert.equal((await saved.json()).code, "invalid_request");
		assert.equal((await api.reset("hal", "p", new Request("http://c/x", { method: "DELETE" }))).status, 400);
	});
	it("answers 503 when the client has no prompts support (mock mode)", async () => {
		assert.equal((await createPromptsApi(stub({})).list("hal")).status, 503);
	});
	it("list carries wolfd's applies and projectOverride through the real client parse to the browser", async () => {
		const row = { ...view, id: "agent.scout", group: "Helper profiles", kind: "editable", scope: "wolf", store: "agents", name: "scout", applies: "on the next subagent spawned", projectOverride: true, placeholders: [] };
		const fetchStub = (async () => Response.json({ prompts: [row] })) as unknown as typeof fetch;
		const client = new HttpConsoleClient({ baseUrl: "http://wolfd", fetch: fetchStub });
		const res = await createPromptsApi(() => client).list("hal");
		const [out] = (await res.json()).prompts;
		assert.equal(out.applies, "on the next subagent spawned");
		assert.equal(out.projectOverride, true);
	});
	it("answers 504 when the wolf did not answer in time", async () => {
		const timedOut = Object.assign(new ProtocolError("engine_error", "wolf did not answer in time (20000 ms)", true), { timedOut: true });
		const res = await createPromptsApi(stub({ listPrompts: async () => { throw timedOut; } })).list("hal");
		assert.equal(res.status, 504);
		assert.deepEqual(await res.json(), { error: "wolf did not answer in time (20000 ms)", code: "engine_error" });
	});
});
