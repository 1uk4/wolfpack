/** Picking a thread in the sidebar tree attaches the floating chat to it (work-wolfpack-e1i205d). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attachRefForHref } from "../../../components/chat-bar/chat-bar-io.ts";

describe("attachRefForHref", () => {
	it("maps a thread page href to the thread's attach ref, resolving the id from the wolf's list", () => {
		const threads = [{ id: "hal/home" }, { id: "hal/feat-b" }];
		assert.deepEqual(attachRefForHref("/wolf/hal/thread/feat-b", threads), { wolf: "hal", threadId: "hal/feat-b", slug: "feat-b" });
	});

	it("falls back to wolf/slug when the list has not loaded, and is null for a non-thread href", () => {
		assert.deepEqual(attachRefForHref("/wolf/hal/thread/x", []), { wolf: "hal", threadId: "hal/x", slug: "x" });
		assert.equal(attachRefForHref("/graph", []), null);
	});
});
