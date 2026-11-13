import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { devicesToShow } from "../../src/core/pack/pack-devices.ts";

const rows = [
	{ id: "a", self: false },
	{ id: "b", self: true },
	{ id: "c", self: false },
];

describe("Pack devices rules", () => {
	it("a browser sees every device; the Mac app sees only this device", () => {
		assert.deepEqual(devicesToShow(rows, false).map((r) => r.id), ["a", "b", "c"]);
		assert.deepEqual(devicesToShow(rows, true).map((r) => r.id), ["b"]);
	});
});
