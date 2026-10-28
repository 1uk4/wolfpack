/** A graduated feature's thread shows the notice in place of the composer. */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

describe("thread-chat closed notice", () => {
	const src = readFileSync(new URL("../components/thread-chat.tsx", import.meta.url), "utf8");
	it("swaps the composer for the Feature graduated notice when closedReason is set", () => {
		assert.match(src, /closedReason !== undefined \? \(/);
		assert.match(src, /data-testid="thread-closed"/);
		assert.match(src, /Feature graduated/);
	});
	it("the thread page passes the server's closed state", () => {
		const page = readFileSync(new URL("../app/wolf/[name]/thread/[threadId]/page.tsx", import.meta.url), "utf8");
		assert.match(page, /closedReason=\{thread\.closed/);
	});
});
