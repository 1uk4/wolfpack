import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spaceKeyLive, spaceKeyMachine, type SpaceKeyInfo } from "../../../components/composer/space-dictation.ts";
import { actionForBinding } from "../../../src/core/ui/keyboard.ts";

const down = (at = 0, running = false) => ({ type: "keydown" as const, at, repeat: false, running });

describe("spaceKeyMachine", () => {
	it("a release before 300ms is a tap that toggles, with no send", () => {
		const m = spaceKeyMachine({ holdMs: 300 });
		m.send(down(1000));
		assert.equal(m.send({ type: "timer", at: 1299 }), "none");
		assert.equal(m.send({ type: "keyup", at: 1299 }), "toggle");
	});

	it("holding to 300ms starts dictation and the release finishes and sends", () => {
		const m = spaceKeyMachine({ holdMs: 300 });
		m.send(down(1000));
		assert.equal(m.send({ type: "timer", at: 1300 }), "start");
		assert.equal(m.send({ type: "keyup", at: 1900 }), "finish-and-send");
	});

	it("a hold while dictation already runs does not restart it, and the release sends", () => {
		const m = spaceKeyMachine({ holdMs: 300 });
		m.send(down(0, true));
		assert.equal(m.send({ type: "timer", at: 300 }), "none");
		assert.equal(m.send({ type: "keyup", at: 500 }), "finish-and-send");
	});

	it("auto-repeat keydowns are ignored", () => {
		const m = spaceKeyMachine({ holdMs: 300 });
		m.send(down(0));
		assert.equal(m.send({ type: "keydown", at: 40, repeat: true, running: false }), "none");
		assert.equal(m.send({ type: "keyup", at: 100 }), "toggle");
	});
});

const info = (over: Partial<SpaceKeyInfo> = {}, target: Partial<SpaceKeyInfo["target"]> = {}): SpaceKeyInfo => ({
	repeat: false,
	composing: false,
	modifier: false,
	modalOpen: false,
	phone: false,
	target: { tag: "body", editable: false, ...target },
	...over,
});

describe("spaceKeyLive", () => {
	it("is live on the body and on an empty composer textarea, not on a textarea with text", () => {
		assert.equal(spaceKeyLive(info()), true);
		assert.equal(spaceKeyLive(info({}, { tag: "textarea", value: "" })), true);
		assert.equal(spaceKeyLive(info({}, { tag: "textarea", value: "hi" })), false);
	});

	it("leaves Space alone on inputs, buttons, links, contenteditable and button-like roles", () => {
		for (const t of [{ tag: "input" }, { tag: "button" }, { tag: "a" }, { tag: "select" }, { tag: "div", editable: true }, { tag: "div", role: "switch" }, { tag: "div", role: "button" }]) {
			assert.equal(spaceKeyLive(info({}, t)), false, JSON.stringify(t));
		}
	});

	it("is off with a modal open, on the phone, on repeat, with a modifier and while composing", () => {
		for (const o of [{ modalOpen: true }, { phone: true }, { repeat: true }, { modifier: true }, { composing: true }]) {
			assert.equal(spaceKeyLive(info(o)), false, JSON.stringify(o));
		}
	});
});

describe("the cheat-sheet row", () => {
	it("never maps a bare space to an action", () => {
		assert.equal(actionForBinding("space"), undefined);
		assert.equal(actionForBinding(" "), undefined);
	});
});
