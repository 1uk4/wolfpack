import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { liveFrameFilter } from "../../../src/server/pack/live-activity-api.ts";

describe("live activity frame filter", () => {
	it("keeps pack.activity, resync and keepalives; drops other hub events", () => {
		assert.notEqual(liveFrameFilter('data: {"type":"pack.activity","event":{}}'), null);
		assert.notEqual(liveFrameFilter('id: b:3\ndata: {"type":"resync"}'), null);
		assert.notEqual(liveFrameFilter(": ping"), null);
		assert.equal(liveFrameFilter('id: b:4\ndata: {"type":"work.changed"}'), null);
		assert.equal(liveFrameFilter("data: not json"), null);
	});
});
