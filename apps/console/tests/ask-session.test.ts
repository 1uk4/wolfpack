/** The composer's button while a questionnaire is open (work-wolfpack-ssPFrEw): which action it takes and what it says. Pure. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { askComposerAction, askQueue } from "../components/ask-session.ts";

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

	it("a subagent's questionnaire never offers or arms 'Send anyway?': a typed note leaves the button disabled", () => {
		const a = { ...base, missing: ["Q1"], noteEmpty: false, own: false };
		assert.deepEqual(askComposerAction(a), { kind: "next", label: "Next", disabled: true, hint: "Answer to continue: Q1" });
		assert.deepEqual(askComposerAction({ ...a, armed: true }), { kind: "next", label: "Next", disabled: true, hint: "Answer to continue: Q1" });
	});

	it("armed does nothing when there is nothing to confirm", () => {
		assert.deepEqual(askComposerAction({ ...base, armed: true }), { kind: "next", label: "Next", disabled: false });
		assert.deepEqual(askComposerAction({ ...base, missing: ["Q8"], armed: true }), { kind: "next", label: "Next", disabled: true, hint: "Answer to continue: Q8" });
	});
});

describe("askQueue", () => {
	it("keeps the paged questionnaires (own and a subagent's) in order and leaves out classic and tool cards", () => {
		const pc = (callId: string, paged: boolean, source?: { kind: "self" | "subagent" | "tool"; label: string }) =>
			({ callId, threadId: "w/a", raisedAt: "", card: { tool: "ask", fields: [], ...(paged ? { paged: true } : {}) }, ...(source ? { source } : {}) }) as never;
		const q = askQueue([pc("own", true), pc("classic", false), pc("tool", true, { kind: "tool", label: "bash" }), pc("kid", true, { kind: "subagent", label: "worker" })]);
		assert.deepEqual(q.map((p) => p.callId), ["own", "kid"]);
	});
});
