/** The console CI shards: every test file lands in exactly one shard, deterministically. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseShard, shardFiles } from "../scripts/shard-files.mjs";

const FILES = ["tests/e.test.ts", "tests/a.test.ts", "tests/c.test.ts", "tests/b.test.ts", "tests/d.test.ts", "tests/f.test.ts", "tests/g.test.ts"];

describe("shardFiles", () => {
	it("gives every file to exactly one shard, round-robin over the sorted list", () => {
		const shards = [1, 2, 3].map((n) => shardFiles(FILES, n, 3));
		assert.deepEqual(shards, [
			["tests/a.test.ts", "tests/d.test.ts", "tests/g.test.ts"],
			["tests/b.test.ts", "tests/e.test.ts"],
			["tests/c.test.ts", "tests/f.test.ts"],
		]);
	});

	it("does not depend on the input order", () => {
		assert.deepEqual(shardFiles([...FILES].reverse(), 2, 3), shardFiles(FILES, 2, 3));
	});
});

describe("parseShard", () => {
	it("reads N/M and rejects anything else", () => {
		assert.deepEqual(parseShard("2/3"), { index: 2, total: 3 });
		assert.throws(() => parseShard("4/3"));
		assert.throws(() => parseShard("0/3"));
		assert.throws(() => parseShard("two"));
	});
});
