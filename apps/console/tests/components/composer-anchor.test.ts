import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickComposerAnchor, SETTLE_FRAMES, trackSettle, type SettleState } from "../../src/core/graph/live/composer-anchor.ts";

const wrap = { left: 100, top: 50, width: 1000, height: 700 };
const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height });

describe("pickComposerAnchor", () => {
	it("anchors on the visible chat element, in the graph's own coordinates", () => {
		assert.deepEqual(pickComposerAnchor(wrap, [rect(300, 650, 400, 60)], null), { x: 200, y: 600, w: 400, h: 60 });
	});
	it("takes the first visible candidate (icon when collapsed) and skips empty ones", () => {
		assert.deepEqual(pickComposerAnchor(wrap, [rect(0, 0, 0, 0), rect(540, 700, 48, 48)], null), { x: 440, y: 650, w: 48, h: 48 });
	});
	it("ignores a rect pinned at the viewport origin and keeps the last good anchor", () => {
		const last = { x: 440, y: 650, w: 48, h: 48 };
		assert.deepEqual(pickComposerAnchor(wrap, [rect(0, 0, 48, 48)], last), last);
		assert.deepEqual(pickComposerAnchor(wrap, [rect(Number.NaN, 10, 48, 48)], last), last);
	});
	it("keeps the last good anchor while the graph wrapper itself is unmeasurable", () => {
		const last = { x: 1, y: 2, w: 3, h: 4 };
		assert.deepEqual(pickComposerAnchor(rect(0, 0, 0, 0), [rect(300, 650, 400, 60)], last), last);
	});
	it("is null when there is no chat element at all", () => {
		assert.equal(pickComposerAnchor(wrap, [null], { x: 1, y: 2, w: 3, h: 4 }), null);
	});
});

// Replays the per-frame reads the layer makes (pick, then track) and returns every anchor it would hand to the overlay.
const replay = (reads: ({ left: number; top: number; width: number; height: number } | null)[]) => {
	const wrapR = { left: 288, top: 0, width: 992, height: 800 };
	type Picked = ReturnType<typeof pickComposerAnchor>;
	let last: Picked = null;
	const out: Picked[] = [];
	for (const r of reads) out.push((last = pickComposerAnchor(wrapR, [r], last)));
	return out;
};
describe("replayed reads", () => {
	const hidden = { left: 0, top: 0, width: 0, height: 0 }; // visibility:hidden icon before its position is known
	it("plain load: never an off-canvas anchor, ends on the real icon", () => {
		const out = replay([hidden, hidden, { left: 760, top: 744, width: 48, height: 48 }]);
		assert.deepEqual(out, [null, null, { x: 472, y: 744, w: 48, h: 48 }]);
	});
	it("three quick toggles ending collapsed: a mid-slide read is superseded by the settled one", () => {
		const out = replay([{ left: 0, top: 0, width: 48, height: 48 }, { left: 120, top: 300, width: 48, height: 48 }, { left: 760, top: 744, width: 48, height: 48 }]);
		assert.equal(out[0], null);
		assert.deepEqual(out[2], { x: 472, y: 744, w: 48, h: 48 });
	});
});

// The collapsed icon slides (left/top transition) and a ResizeObserver never fires for a move: one mid-slide read must not stay the anchor.
describe("trackSettle", () => {
	it("is not settled while the anchor moves, settles once it holds still, and resets on a new move", () => {
		let s: SettleState = { anchor: null, still: 0 };
		for (const y of [100, 300, 500, 700]) s = trackSettle(s, { x: 440, y, w: 48, h: 48 });
		assert.ok(s.still < SETTLE_FRAMES);
		for (let i = 0; i <= SETTLE_FRAMES; i++) s = trackSettle(s, { x: 440, y: 744, w: 48, h: 48 });
		assert.ok(s.still >= SETTLE_FRAMES);
		s = trackSettle(s, { x: 440, y: 700, w: 48, h: 48 });
		assert.equal(s.still, 0);
	});
});
