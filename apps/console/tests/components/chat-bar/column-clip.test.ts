import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clipColumn } from "../../../components/chat-bar/column-store.ts";

describe("the chat bar's column beside a side panel", () => {
	it("ends at the left edge of a panel that covers its right side", () => {
		assert.deepEqual(clipColumn({ left: 200, width: 1000 }, 700), { left: 200, width: 500 });
	});

	it("is unchanged with no panel, a panel past the column, or a panel that would leave no column", () => {
		assert.deepEqual(clipColumn({ left: 200, width: 1000 }, null), { left: 200, width: 1000 });
		assert.deepEqual(clipColumn({ left: 200, width: 1000 }, 1300), { left: 200, width: 1000 });
		assert.deepEqual(clipColumn({ left: 200, width: 1000 }, 150), { left: 200, width: 1000 });
	});
});
