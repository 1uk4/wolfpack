import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nerveHead, nervePath, nerveTrail } from "../../../src/core/index.ts";

const edges = [
	{ from: "dom:wp", to: "sec:a" },
	{ from: "sec:a", to: "sec:b" },
	{ from: "sec:b", to: "ent:1" },
	{ from: "sec:a", to: "ent:2" },
	{ from: "dom:other", to: "sec:z" },
];

describe("nervePath", () => {
	it("runs domain, then each section down the tree, then the entry", () => {
		assert.deepEqual(nervePath(edges, "dom:wp", "sec:b", "ent:1"), ["dom:wp", "sec:a", "sec:b", "ent:1"]);
	});
	it("follows edges whichever way they are stored", () => {
		assert.deepEqual(nervePath([{ from: "ent:1", to: "sec:b" }, { from: "sec:b", to: "dom:wp" }], "dom:wp", "sec:b", "ent:1"), ["dom:wp", "sec:b", "ent:1"]);
	});
	it("stops at the section when the entry is not on the map yet, and at the domain when nothing else is", () => {
		assert.deepEqual(nervePath(edges, "dom:wp", "sec:a", "ent:new"), ["dom:wp", "sec:a"]);
		assert.deepEqual(nervePath(edges, "dom:wp", undefined, undefined), ["dom:wp"]);
	});
	it("goes straight from domain to entry when the section is unknown", () => {
		assert.deepEqual(nervePath(edges, "dom:wp", "sec:nope", "ent:2"), ["dom:wp", "sec:a", "ent:2"]);
	});
	it("ignores a section that is not under the domain and still reaches the entry", () => {
		assert.deepEqual(nervePath(edges, "dom:wp", "sec:z", "ent:1"), ["dom:wp", "sec:a", "sec:b", "ent:1"]);
	});
});

describe("nerve geometry", () => {
	const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 30 }]; // length 40
	it("nerveHead is the point t of the way along the polyline, by length", () => {
		assert.deepEqual(nerveHead(pts, 0), { x: 0, y: 0 });
		assert.deepEqual(nerveHead(pts, 0.5), { x: 10, y: 10 });
		assert.deepEqual(nerveHead(pts, 1), { x: 10, y: 30 });
	});
	it("nerveTrail is the lit stretch behind the head, cut to tailFrac of the length", () => {
		assert.deepEqual(nerveTrail(pts, 0.5, 0.25), [{ x: 10, y: 0 }, { x: 10, y: 10 }]);
		assert.deepEqual(nerveTrail(pts, 0.125, 0.5), [{ x: 0, y: 0 }, { x: 5, y: 0 }]);
		assert.deepEqual(nerveTrail(pts, 1, 2), pts);
	});
});
