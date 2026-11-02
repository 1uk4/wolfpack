import assert from "node:assert/strict";
import { test } from "node:test";
import { newMessageId, newUserMessage, randomHex8 } from "../src/core/native-messages.ts";

// A phone opening the console over plain http on a tailnet IP is not a secure
// context: browsers leave crypto.randomUUID undefined there. Sending a message
// must still work.
test("message ids do not need crypto.randomUUID (insecure http context)", () => {
	const c = globalThis.crypto as unknown as { randomUUID?: unknown };
	const saved = c.randomUUID;
	Object.defineProperty(c, "randomUUID", { value: undefined, configurable: true, writable: true });
	try {
		assert.match(newMessageId(), /^msg_[0-9a-z]+_[0-9a-f]{8}$/);
		assert.match(randomHex8(), /^[0-9a-f]{8}$/);
		const m = newUserMessage("ping");
		assert.equal(typeof m.id, "string");
		assert.notEqual(newMessageId(), newMessageId());
	} finally {
		Object.defineProperty(c, "randomUUID", { value: saved, configurable: true, writable: true });
	}
});
