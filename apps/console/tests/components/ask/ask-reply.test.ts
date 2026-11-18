import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { replyLabel } from "../../../components/ask/ask-reply.ts";

describe("replyLabel", () => {
	it("keeps a markdown link's text, drops images and emphasis, and cuts at 40", () => {
		assert.equal(replyLabel({ label: "Use [the **docs**](https://x.example/a_b) first" }), "Use the docs first");
		assert.equal(replyLabel({ label: "See ![diagram](https://x.example/p.png) now" }), "See now");
		assert.equal(replyLabel({ label: "Read [the page](https://x.example/a_(b)) first" }), "Read the page first");
		assert.equal(replyLabel({ label: "x".repeat(50) }), `${"x".repeat(39)}…`);
	});
});
