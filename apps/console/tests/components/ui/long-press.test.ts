/** The phone long-press that opens a Hint tooltip: timing, cancelling, auto-close and the swallowed click. */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { createLongPress } from "../../../components/ui/long-press.ts";

const touch = { pointerType: "touch", clientX: 10, clientY: 10 };

describe("createLongPress", () => {
	let log: string[];
	beforeEach(() => {
		mock.timers.enable({ apis: ["setTimeout"] });
		log = [];
	});
	afterEach(() => mock.timers.reset());
	const make = () => createLongPress(() => log.push("open"), () => log.push("close"));

	it("a touch held 400ms opens the tip, it closes 1.5s later, and the click that ends the press is swallowed once", () => {
		const lp = make();
		lp.down(touch);
		mock.timers.tick(399);
		assert.deepEqual(log, []);
		mock.timers.tick(1);
		assert.deepEqual(log, ["open"]);
		lp.end();
		assert.equal(lp.swallowClick(), true);
		assert.equal(lp.swallowClick(), false);
		mock.timers.tick(1500);
		assert.deepEqual(log, ["open", "close"]);
	});

	it("a short tap, a lift, a drag past the slop and a mouse press never open it, and the click goes through", () => {
		const lp = make();
		lp.down(touch);
		mock.timers.tick(200);
		lp.end();
		mock.timers.tick(1000);
		lp.down(touch);
		lp.move({ clientX: 40, clientY: 10 });
		mock.timers.tick(1000);
		lp.down({ ...touch, pointerType: "mouse" });
		mock.timers.tick(1000);
		assert.deepEqual(log, []);
		assert.equal(lp.swallowClick(), false);
	});

	it("a mouse press after a touch long-press is not swallowed, and the tip stays up until its timer or a dismiss", () => {
		const lp = make();
		lp.down(touch);
		mock.timers.tick(400);
		assert.equal(lp.showing(), true);
		lp.end();
		assert.equal(lp.showing(), true);
		lp.down({ ...touch, pointerType: "mouse" });
		assert.equal(lp.swallowClick(), false);
		lp.dismiss();
		assert.deepEqual(log, ["open", "close"]);
		assert.equal(lp.showing(), false);
	});

	it("a small wobble under the slop keeps the hold alive", () => {
		const lp = make();
		lp.down(touch);
		lp.move({ clientX: 14, clientY: 12 });
		mock.timers.tick(400);
		assert.deepEqual(log, ["open"]);
	});
});
