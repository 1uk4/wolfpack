import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSseParser, type SseFrame } from "../../components/graph/live/live-client.ts";

describe("live feed SSE parser", () => {
	it("assembles frames split across chunks, keeps ids, skips keepalive comments", () => {
		const got: SseFrame[] = [];
		const push = createSseParser((f) => got.push(f));
		push(": ping\n\ndata: {\"type\":\"pack.act");
		push("ivity\"}\n\nid: b:3\ndata: {\"type\":\"resync\"}\n\n");
		assert.deepEqual(got, [{ id: undefined, data: '{"type":"pack.activity"}' }, { id: "b:3", data: '{"type":"resync"}' }]);
	});
});
