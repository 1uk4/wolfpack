import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clampIconPos, defaultIconPos, isDrag, loadIconPos, saveIconPos, snapIconToEdge, ICON_POS_KEY } from "../../../src/core/thread/bar-icon.ts";
import type { KeyValueStore } from "../../../src/core/thread/chat-bar.ts";

const mem = () => {
	const m = new Map<string, string>();
	const s: KeyValueStore = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
	return { m, s };
};
// A 390x844 phone with a 47px notch and a 34px home indicator; the icon is 48px wide with an 8px margin.
const phone = { width: 390, height: 844 };
const notch = { top: 47, right: 0, bottom: 34, left: 0 };
const none = { top: 0, right: 0, bottom: 0, left: 0 };

describe("floating chat icon position", () => {
	it("is remembered per device, and a stored spot that falls off-screen after a resize snaps back to the bottom centre", () => {
		const { s } = mem();
		saveIconPos(s, { x: 300, y: 500 });
		assert.deepEqual(loadIconPos(s, phone, notch), { x: 300, y: 500 });
		// The window shrinks to 320x480: the stored spot is off-screen, so the icon returns to the bottom centre (margin 8, above the home bar).
		assert.deepEqual(loadIconPos(s, { width: 320, height: 480 }, notch), { x: 136, y: 390 });
		// A spot only a little over the edge is still pulled just inside.
		assert.deepEqual(clampIconPos({ x: 4, y: 100 }, phone, none), { x: 8, y: 100 });
		// A far-off-screen or negative spot clamps to the top-left corner of the safe area.
		assert.deepEqual(clampIconPos({ x: -90, y: -90 }, phone, notch), { x: 8, y: 55 });
	});

	it("starts bottom centre (of the page column when given) when nothing, or garbage, is stored", () => {
		const { s } = mem();
		assert.deepEqual(loadIconPos(s, phone, notch), { x: 171, y: 754 });
		s.setItem(ICON_POS_KEY, "{not json");
		assert.deepEqual(loadIconPos(s, phone, none), { x: 171, y: 788 });
		// Centred on a column whose middle is at 500 in a 1000px window.
		assert.deepEqual(loadIconPos(s, { width: 1000, height: 800 }, none, 500), { x: 476, y: 744 });
	});

	it("snaps to the nearer screen edge, keeping its height inside the safe area", () => {
		assert.deepEqual(snapIconToEdge({ x: 100, y: 300 }, phone, notch), { x: 8, y: 300 }); // centre 124 < 195: left
		assert.deepEqual(snapIconToEdge({ x: 250, y: 300 }, phone, notch), { x: 334, y: 300 }); // centre 274 > 195: right
		assert.deepEqual(snapIconToEdge({ x: 250, y: 830 }, phone, notch), { x: 334, y: 754 }); // dropped over the home bar
	});

	it("a drag needs more than 6px of travel; less is a tap", () => {
		assert.equal(isDrag(3, 4), false); // 5px
		assert.equal(isDrag(0, 6), false);
		assert.equal(isDrag(5, 5), true); // 7.07px
	});
});
