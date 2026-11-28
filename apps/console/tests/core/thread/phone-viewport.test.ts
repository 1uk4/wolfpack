import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPhoneViewport } from "../../../src/core/thread/phone-viewport.ts";
import { phoneIconPos } from "../../../src/core/thread/bar-icon.ts";
import { activityPanelBox } from "../../../src/core/graph/live/activity-panel.ts";

describe("phone viewport", () => {
	it("a phone turned to landscape (844x390, touch) is a phone, so the chat icon is centred and the panel lifts clear of it; a short desktop window is not", () => {
		assert.equal(isPhoneViewport(390, 844, true), true);
		assert.equal(isPhoneViewport(844, 390, true), true);
		assert.equal(isPhoneViewport(844, 390, false), false); // a short mouse window stays desktop
		assert.equal(isPhoneViewport(1280, 800, false), false);
		// What a landscape phone then gets: the icon at x398 (centred), and the panel bottom above the icon's top.
		assert.deepEqual(phoneIconPos({ width: 844, height: 390 }, { top: 0, right: 0, bottom: 0, left: 0 }), { x: 398, y: 334 });
		assert.match(activityPanelBox(true).bottom, /64px/);
	});
});
