/** The composer's button while a questionnaire is open (work-wolfpack-ssPFrEw): which action it takes and what it says. Pure. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { askComposerAction } from "../components/ask-session.ts";

const base = { pages: 3, page: 0, missing: [] as string[], noteEmpty: true, expanded: true };

describe("askComposerAction", () => {
	it("reads Next on an earlier page and Submit on the last", () => {
		assert.deepEqual(askComposerAction(base), { kind: "next", label: "Next", disabled: false });
		assert.deepEqual(askComposerAction({ ...base, page: 2 }), { kind: "submit", label: "Submit", disabled: false });
	});

	it("with required questions open and an empty composer the button is disabled and names them", () => {
		assert.deepEqual(askComposerAction({ ...base, missing: ["Q8", "Q10"] }), { kind: "next", label: "Next", disabled: true, hint: "Answer to continue: Q8, Q10" });
		assert.equal(askComposerAction({ ...base, page: 2, missing: ["Q2"] }).kind, "submit");
	});

	it("with required questions open and a note typed the button asks to confirm", () => {
		assert.deepEqual(askComposerAction({ ...base, page: 2, missing: ["Q8"], noteEmpty: false }), { kind: "confirm", label: "Submit", disabled: false });
	});

	it("a collapsed sheet is a normal Send, whatever is missing", () => {
		assert.deepEqual(askComposerAction({ ...base, missing: ["Q1"], expanded: false }), { kind: "send", label: "Send", disabled: false });
	});

	it("armed, the confirm button asks 'Send anyway?' and names the unanswered questions", () => {
		const armed = { ...base, page: 2, missing: ["Q8", "Q10"], noteEmpty: false, armed: true };
		assert.deepEqual(askComposerAction(armed), { kind: "confirm", label: "Send anyway?", disabled: false, armed: true, hint: "Q8 and Q10 aren't answered", ariaLabel: "Send anyway? Q8 and Q10 aren't answered" });
		assert.equal(askComposerAction({ ...armed, missing: ["Q8"] }).hint, "Q8 isn't answered");
		assert.equal(askComposerAction({ ...armed, missing: ["Q1", "Q2", "Q3"] }).hint, "Q1, Q2 and Q3 aren't answered");
	});

	it("armed does nothing when there is nothing to confirm", () => {
		assert.deepEqual(askComposerAction({ ...base, armed: true }), { kind: "next", label: "Next", disabled: false });
		assert.deepEqual(askComposerAction({ ...base, missing: ["Q8"], armed: true }), { kind: "next", label: "Next", disabled: true, hint: "Answer to continue: Q8" });
	});
});
