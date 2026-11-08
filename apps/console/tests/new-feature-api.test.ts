import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpConsoleClient } from "@wolfpack/client";
import { createNewFeatureApi } from "../src/server/new-feature-api.ts";

const req = (body: unknown) => new Request("http://c/x", { method: "POST", body: JSON.stringify(body) });

describe("new feature API", () => {
	it("posts the idea to the named wolf's new-feature route and answers the thread id", async () => {
		const seen: { url: string; body: string }[] = [];
		const fetchStub = (async (url: string, init: RequestInit) => {
			seen.push({ url, body: String(init.body) });
			return Response.json({ messageId: "m1", disposition: "started", threadId: "sfo-wolf/home" });
		}) as unknown as typeof fetch;
		const client = new HttpConsoleClient({ baseUrl: "http://wolfd", fetch: fetchStub });
		const res = await createNewFeatureApi(() => client).start("sfo-wolf", req({ idea: "dark mode" }));
		assert.equal(res.status, 200);
		assert.equal((await res.json()).threadId, "sfo-wolf/home");
		assert.equal(seen[0]!.url, "http://wolfd/v1/wolves/sfo-wolf/new-feature");
		assert.deepEqual(JSON.parse(seen[0]!.body), { idea: "dark mode" });
	});
	it("answers 409 when the wolf's home thread is busy", async () => {
		const fetchStub = (async () => Response.json({ code: "busy", message: "thread is busy", retryable: true }, { status: 409 })) as unknown as typeof fetch;
		const client = new HttpConsoleClient({ baseUrl: "http://wolfd", fetch: fetchStub });
		assert.equal((await createNewFeatureApi(() => client).start("w", req({}))).status, 409);
	});
});
