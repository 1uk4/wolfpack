import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickHomeThread } from "../../../src/core/thread/home-thread.ts";
import { barHiddenFor } from "../../../src/core/ui/bar-visibility.ts";

const wolves = [{ name: "lib", librarian: true, status: "online" }, { name: "1uk4", status: "online" }, { name: "remote", status: "offline" }];

describe("pickHomeThread", () => {
	it("picks the owner's own wolf's home thread", () => {
		const threads = { "1uk4": [{ id: "1uk4/f1", title: "feat", kind: "feature" }, { id: "1uk4/home", title: "Home", kind: "home" }], lib: [{ id: "lib/home", title: "Home", kind: "home" }] };
		assert.deepEqual(pickHomeThread(wolves, threads), { wolf: "1uk4", threadId: "1uk4/home", slug: "home" });
	});

	it("ignores closed threads, feature threads and offline wolves, and returns null when nothing fits", () => {
		assert.equal(pickHomeThread(wolves, { "1uk4": [{ id: "1uk4/home", title: "Home", kind: "home", closed: true }, { id: "1uk4/f1", title: "feat", kind: "feature" }] }), null);
		assert.equal(pickHomeThread([{ name: "remote", status: "offline" }], { remote: [{ id: "remote/home", title: "Home", kind: "home" }] }), null);
		assert.equal(pickHomeThread(wolves, {}), null);
	});
});

describe("barHiddenFor", () => {
	it("hides on the pairing route and while something covers the window, and stays on /chat/new", () => {
		assert.equal(barHiddenFor("/pair", { reasons: [] }), true);
		assert.equal(barHiddenFor("/kb", { reasons: ["graph"] }), true);
		assert.equal(barHiddenFor("/chat/new", { reasons: [] }), false);
		assert.equal(barHiddenFor("/wolf/w/thread/home", { reasons: [] }), false);
	});
});
