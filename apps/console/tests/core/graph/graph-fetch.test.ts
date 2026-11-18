import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { graphKey, newestRequest } from "../../../src/core/graph/graph-fetch.ts";

const st = (over: Partial<{ branch: string; ahead: number; behind: number; sha: string }> = {}) => ({
	branch: over.branch ?? "feat/x",
	ahead: over.ahead ?? 1,
	behind: over.behind ?? 0,
	commits: [{ sha: over.sha ?? "abc" }],
});

describe("graphKey", () => {
	it("is equal for two refreshes of the same git state and differs when the head moves", () => {
		assert.equal(graphKey(st()), graphKey(st()));
		assert.equal(graphKey(st()), "feat/x@abc+1-0");
		assert.notEqual(graphKey(st()), graphKey(st({ sha: "def" })));
		assert.equal(graphKey(undefined), "");
	});
});

describe("newestRequest", () => {
	it("only the newest request stays current", () => {
		const begin = newestRequest();
		const first = begin();
		assert.equal(first(), true);
		const second = begin();
		assert.equal(first(), false);
		assert.equal(second(), true);
	});
});
