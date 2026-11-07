/**
 * Render smoke tests — the lesson from the v2 bugs: protocol tests don't see
 * rendering. These render the interaction cards to static HTML and assert on
 * the output. No DOM needed (react-dom/server).
 *
 * tsx note: tsx ignores tsconfig's `jsx` field and uses the CLASSIC JSX
 * transform (React.createElement), so `React` must be a resolvable global.
 * The shim below provides it; Vite/Next use the automatic runtime and don't
 * care.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageResponse } from "../components/ai-elements/message.tsx";
import { DispatchCard } from "../components/artifacts/dispatch-card.tsx";
import { JobsContext } from "../components/jobs-context.ts";
import { ChatActionsContext } from "../components/chat-actions-context.ts";
import type { JobRecord } from "../src/core/contracts.ts";
import { AnsweredCard } from "../components/answered-card.tsx";
import {
	buildAnswer,
	normalizeOptions,
	resolveCorrect,
	type QuestionData,
} from "../src/core/question-core.ts";

const quizInput = {
	question: "Which planet is closest to the sun?",
	options: [{ label: "Venus" }, { label: "Mercury" }, { label: "Mars" }],
	correctAnswer: "Mercury",
	explanation: "Mercury is the innermost planet.",
};

function quizQD(): QuestionData {
	const options = normalizeOptions(quizInput.options);
	return {
		id: "q1",
		kind: "quiz",
		question: quizInput.question,
		mode: "single-select",
		options,
		correctIndices: resolveCorrect(quizInput.correctAnswer, options).indices,
		explanation: quizInput.explanation,
		createdAt: new Date().toISOString(),
	};
}

function askQD(): QuestionData {
	const options = normalizeOptions([{ label: "Very" }, { label: "Somewhat" }]);
	return {
		id: "a1",
		kind: "ask",
		question: "How confident are you?",
		mode: "single-select",
		options,
		createdAt: new Date().toISOString(),
	};
}

describe("DispatchCard — the BYOK refusal tone (owner, 2026-09-22)", () => {
	const job = (over: Partial<JobRecord>): JobRecord => ({
		id: "j1",
		kind: "research",
		chatId: "c1",
		toolCallId: "t1",
		status: "error",
		activity: "",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...over,
	});
	const inJobs = (jobs: JobRecord[]) => (
		<JobsContext.Provider value={jobs}>
			<ChatActionsContext.Provider
				value={{ chatId: "c1", syncFromServer: async () => {}, sendText: () => {}, openSetup: () => {} }}
			>
				<DispatchCard toolCallId="t1" kind="research" />
			</ChatActionsContext.Provider>
		</JobsContext.Provider>
	);

	it("a models-refused job is INFO: quiet card, 'needs model setup', deep-link to the dialog", () => {
		const html = renderToStaticMarkup(
			inJobs([job({ error: "No model configured — set up your models first (missing: cheap)" })]),
		);
		assert.ok(html.includes('data-testid="dispatch-refused"'));
		assert.ok(html.includes("needs model setup"));
		assert.ok(html.includes('data-testid="dispatch-setup-link"'));
		assert.ok(html.includes("Set up models"));
		assert.ok(!html.includes("failed"));
		assert.ok(!html.includes("text-red-500"));
	});

	it("a key-refused job is INFO: 'needs a provider key', 'Add a key' (zero-keys wave, 66dbea9)", () => {
		const html = renderToStaticMarkup(
			inJobs([job({ error: "No OpenRouter key is set — add one in Settings → Keys" })]),
		);
		assert.ok(html.includes('data-testid="dispatch-refused"'));
		assert.ok(html.includes("needs a provider key"));
		assert.ok(html.includes("Add a key"));
		assert.ok(html.includes('data-testid="dispatch-setup-link"'));
		assert.ok(!html.includes("failed"));
	});

	it("a real failure keeps the honest red failure", () => {
		const html = renderToStaticMarkup(inJobs([job({ error: "FAILED: headless crashed" })]));
		assert.ok(html.includes('data-testid="dispatch-settled"'));
		assert.ok(html.includes("failed"));
		assert.ok(html.includes("text-red-500"));
		assert.ok(!html.includes("dispatch-refused"));
	});

	it("a delivered job reads delivered, untouched by the wave", () => {
		const html = renderToStaticMarkup(inJobs([job({ status: "done", error: undefined })]));
		assert.ok(html.includes("delivered"));
	});
});

describe("render smoke tests", () => {

	it("AnsweredCard grades quiz answers (✓/✗ + explanation)", () => {
		const answer = buildAnswer(quizQD(), { values: ["Venus"] });
		const html = renderToStaticMarkup(<AnsweredCard answer={answer} />);
		assert.match(html, /incorrect/);
		// Tucked for ALL questions (owner, 2026-10-07): the explanation sits
		// behind the Why toggle — never center stage.
		assert.ok(html.includes("tucked-explanation"), "the Why toggle mounts");
		assert.ok(!html.includes("innermost"), "explanation hidden until opened");
		// Glyph-shaped SVG marks (owner preference) — pinned via data-mark.
		assert.ok(html.includes('data-mark="check"') && html.includes('data-mark="x"'));
	});

	it("AnsweredCard shows the confidence rail on quiz answers (record, no disc)", () => {
		// The slider's rail, disc removed: same paint, same ticks, the % read-out.
		const answer = buildAnswer(quizQD(), { values: ["Venus"], confidence: 70 });
		const html = renderToStaticMarkup(<AnsweredCard answer={answer} />);
		assert.match(html, /data-testid="answered-confidence"/);
		assert.match(html, /data-testid="confidence-rail"/);
		assert.match(html, /70%/);
		// It is a RECORD, not a control — no range input on the card.
		assert.ok(!html.includes('type="range"'));
	});

	it("AnsweredCard hides the rail where no confidence exists (IDK, older records)", () => {
		const idk = buildAnswer(quizQD(), { values: [], dontKnow: true });
		const idkHtml = renderToStaticMarkup(<AnsweredCard answer={idk} />);
		assert.ok(!idkHtml.includes("answered-confidence"), "IDK sent no confidence");

		const ask = buildAnswer(askQD(), { other: "Shaky" });
		const askHtml = renderToStaticMarkup(<AnsweredCard answer={ask} />);
		assert.ok(!askHtml.includes("answered-confidence"), "ask never had one");
	});

	it("AnsweredCard renders the learner's own Other answer AS an option row", () => {
		const answer = buildAnswer(askQD(), { other: "Fairly confident — but shaky on applications" });
		const html = renderToStaticMarkup(<AnsweredCard answer={answer} />);
		assert.ok(html.includes('data-testid="answered-other"'), "the Other answer is an option row");
		assert.match(html, /border-primary bg-accent/, "styled like its selected siblings");
		assert.match(html, /shaky on applications/, "the typed words render");
		// Inside the options container — same list, not a loose quote outside it.
		assert.ok(
			html.indexOf("Very") < html.indexOf("answered-other"),
			"the Other row sits with the listed options",
		);
	});

	it("AnsweredCard promotes the learner's thinking to a first-class block", () => {
		const answer = buildAnswer(quizQD(), {
			values: ["Venus"],
			thinking: "I picked Venus because it looks brightest — but now I realize brightness isn't distance.",
		});
		const html = renderToStaticMarkup(<AnsweredCard answer={answer} />);
		assert.ok(html.includes('data-testid="your-thinking"'), "the thinking row exists");
		assert.match(html, /YOUR THINKING/, "labeled as the learner's voice (all caps, owner round 3)");
		// COLLAPSED ARRIVAL (owner round 2, 2026-10-05): the SSR output is the
		// trigger row only — the thinking text is one click away, never loud.
		assert.ok(html.includes('data-testid="your-thinking-trigger"'), "the trigger row");
		assert.ok(html.includes('aria-expanded="false"'), "arrives collapsed");
		// ONE GEOMETRY, NO BAND IN CARDS (owner round five, 2026-10-07): the
		// accent lift read too light — rail only, heights match everywhere.
		const yourRow = html.slice(html.indexOf('data-testid="your-thinking"'));
		assert.ok(!yourRow.slice(0, 400).includes("bg-card") && !yourRow.slice(0, 400).includes("bg-accent"), "no band inside the card");
		// THE RAIL GROUPS (owner correction): the label sits INSIDE the rail —
		// ownership readable from the rail alone, collapsed or expanded.
		const railAt = html.indexOf("border-l-[calc(3ch-14px)]");
		const trigAt = html.indexOf("your-thinking-trigger");
		assert.ok(railAt !== -1 && railAt < trigAt, "the rail opens before the label (same quote)");
		assert.ok(!html.includes("brightness isn&#x27;t distance"), "the text is hidden until expanded");
		assert.ok(!html.includes("Note:"), "no longer a muted 'Note:' footnote");
		// The thinking sits ABOVE the verdict's explanation — the dialogue of
		// thinking, not an afterthought.
		assert.ok(
			html.indexOf("your-thinking") < html.indexOf("tucked-explanation"),
			"thinking before the explanation toggle",
		);
	});

	it("AnsweredCard does NOT grade ask answers", () => {
		const qd: QuestionData = {
			id: "a1",
			kind: "ask",
			question: "How confident are you?",
			mode: "single-select",
			options: normalizeOptions([{ label: "Very" }, { label: "Somewhat" }]),
			createdAt: new Date().toISOString(),
		};
		const answer = buildAnswer(qd, { values: ["Somewhat"] });
		const html = renderToStaticMarkup(<AnsweredCard answer={answer} />);
		assert.ok(!html.includes("incorrect") && !html.includes('data-mark="x"'), "ask answers never get quiz grading UI");
		assert.match(html, /Somewhat/);
	});

	it("AnsweredCard renders dismissal as skipped", () => {
		const answer = { ...buildAnswer(quizQD(), { dontKnow: true }), dismissed: true };
		const html = renderToStaticMarkup(<AnsweredCard answer={answer} />);
		assert.match(html, /skipped/);
	});
});

describe("math rendering (streamdown + KaTeX)", () => {
	// Standard authoring: $...$ inline and $$ on separate lines for display.
	// The legacy backslash reader remains for existing content.
	// Full coverage: render-markdown.test.tsx.
	it("renders standard $...$ as inline math", () => {
		const html = renderToStaticMarkup(<MessageResponse>{"The map $f(x) = x^2$ is smooth."}</MessageResponse>);
		assert.ok(html.includes("katex"), `$-math must render, got: ${html.slice(0, 300)}`);
		assert.ok(!html.includes("katex-display"), "single-dollar math is inline");
	});

	it("renders display math ($$ fenced on own lines — the transform's target form)", () => {
		const html = renderToStaticMarkup(<MessageResponse>{"$$\n\\int_0^1 x^2\\,dx = \\tfrac{1}{3}\n$$"}</MessageResponse>);
		assert.ok(html.includes("katex-display"), "fenced display math should render as display KaTeX");
	});

	it("one-line $$...$$ renders inline (micromark behavior — the transform relies on it for \(...\))", () => {
		// micromark treats a one-line $$...$$ inside a paragraph as 2-dollar
		// inline mathText, not flow math. That is exactly how the transformed
		// \(...\) renders inline; pin the behavior so a renderer swap can't
		// silently change it.
		const html = renderToStaticMarkup(<MessageResponse>{"$$\\int_0^1 x^2\\,dx$$"}</MessageResponse>);
		assert.ok(html.includes("katex") && !html.includes("katex-display"), "one-liner should render inline");
	});

	it("does NOT eat escaped currency (\\$5 stays text)", () => {
		// With dollar math enabled, Markdown-escaped dollars remain literal.
		const html = renderToStaticMarkup(<MessageResponse>{"It costs \\$5 and \\$10 more."}</MessageResponse>);
		assert.ok(!html.includes("katex"), "escaped currency must not parse as math");
		assert.match(html, /\$5/);
	});

});

describe("the collapsed question bar", () => {

});

// ─── the explain reveal (free-recall, owner 2026-09-27) ────────────────────

describe("AnsweredCard: the explain variant", () => {
	const explainQD = (): QuestionData => ({
		id: "e1",
		kind: "explain",
		question: "Explain why the null result matters.",
		mode: "text",
		options: [],
		committedAnswer: "It ruled out the luminiferous aether — a stationary aether predicts a fringe shift, and none was seen.",
		createdAt: new Date().toISOString(),
	});

	it("reveals the single committed answer (reasoning inside it) with NO verdict chips", () => {
		const html = renderToStaticMarkup(<AnsweredCard answer={buildAnswer(explainQD(), { text: "Something about relativity?" })} />);
		assert.match(html, /Explain/, "labeled as the explain kind");
		assert.match(html, /The answer:/);
		assert.match(html, /luminiferous aether/);
		assert.match(html, /fringe shift/);
		assert.ok(!html.includes("Why:"), "no separate explanation field — one committed answer (owner 2026-09-27)");
		assert.ok(!html.includes("incorrect") && !html.includes("correct</"), "no client grading");
		assert.ok(!html.includes('data-mark="x"') && !html.includes('data-mark="check"'));
	});

	it("renders his free text as the answer", () => {
		const html = renderToStaticMarkup(<AnsweredCard answer={buildAnswer(explainQD(), { text: "Something about relativity?" })} />);
		assert.match(html, /Something about relativity\?/);
	});

});

describe("answered-card kind labels", () => {
	it("old records (no tool) keep the kind labels", () => {
		const oldQD: QuestionData = {
			id: "o2",
			kind: "explain",
			question: "Explain why the null result matters.",
			mode: "text",
			options: [],
			committedAnswer: "It ruled out the luminiferous aether.",
			createdAt: new Date().toISOString(),
		};
		const html = renderToStaticMarkup(<AnsweredCard answer={buildAnswer(oldQD, { text: "A hand-wave." })} />);
		assert.match(html, /Explain/, "no tool field → the standing kind label");
	});
});

// ─── the two roles in the UI (predict vs check, owner 2026-10-03) ─────────
// Predictions arrive OPEN before the teaching; checks arrive collapsed after
// it. The answered card tells them apart (eyebrow) and tucks a prediction's
// explanation (the teaching that follows IS the explanation) while a check's
// stays inline.
describe("predict vs check rendering", () => {

	it("a prediction answer SHOWS the verdict but TUCKS the explanation behind a toggle", () => {
		const qd: QuestionData = { ...quizQD(), questionType: "predict" };
		const answer = buildAnswer(qd, { values: ["Venus"] }); // wrong on purpose
		const html = renderToStaticMarkup(<AnsweredCard answer={answer} />);
		assert.ok(html.includes("Prediction"), "the eyebrow distinguishes the card");
		assert.ok(/incorrect|wrong|&times;|✗/i.test(html), "the verdict still shows (owner: predictions are graded)");
		assert.ok(!html.includes("Why:"), "the explanation is not center stage");
		assert.ok(html.includes("tucked-explanation"), "it sits behind the toggle");
	});

	it("a check answer tucks the explanation like every question (owner, 2026-10-07)", () => {
		const answer = buildAnswer(quizQD(), { values: ["Venus"] });
		const html = renderToStaticMarkup(<AnsweredCard answer={answer} />);
		assert.ok(html.includes("tucked-explanation"), "the prediction tuck is now universal");
		assert.ok(!html.includes("Why:"), "no inline explanation — behind the toggle");
	});

	it("legacy `note` records still render their thinking", () => {
		const legacy = { ...buildAnswer(quizQD(), { values: ["Mercury"] }), note: "a 2026-09 answer" };
		const legacyHtml = renderToStaticMarkup(<AnsweredCard answer={legacy} />);
		assert.ok(legacyHtml.includes("a 2026-09 answer") || legacyHtml.includes('data-testid="your-thinking-trigger"'), "records from before the rename still render");
	});
});

// ─── details + option descriptions render as markdown (owner, 2026-10-12) ──

describe("question context renders as markdown everywhere (owner, 2026-10-12)", () => {

	it("settled ask card keeps the details line and option descriptions — retroactively from the persisted call", () => {
		const input = {
			question: "Which destination?",
			details: "Inline $a^2+b^2=c^2$ and display:\n$$\nE = mc^2\n$$",
			options: [
				{ label: "Classical", description: "Entropy $H(X)$ first." },
				{ label: "ML toolkit" },
			],
		};
		const qd: QuestionData = {
			id: "d2",
			kind: "ask",
			question: input.question,
			mode: "single-select",
			options: normalizeOptions(input.options),
			createdAt: new Date().toISOString(),
		};
		const answer = buildAnswer(qd, { values: ["Classical"] });
		const html = renderToStaticMarkup(<AnsweredCard answer={answer} input={input} />);
		const katexCount = (html.match(/class="katex"/g) ?? []).length;
		assert.ok(katexCount >= 3, `details (inline+display) + description math render (got ${katexCount})`);
		assert.match(html, /Entropy/, "the option description text is present");
		assert.ok(html.includes("katex-display"), "display math in the details line renders");
	});

	it("settled quiz card keeps the details line; quiz options stay description-less", () => {
		const input = {
			question: "Typical sets?",
			details: "Recall $2^{nH(X)}$ — the asymptotic equipartition bound.",
			options: [
				{ label: "$\\approx 2^{nH(X)}$", value: "a" },
				{ label: "$nH(X)$", value: "b" },
			],
			explanation: "AEP.",
			correctAnswer: "a",
		};
		const options = normalizeOptions(input.options);
		const qd: QuestionData = {
			id: "d3",
			kind: "quiz",
			question: input.question,
			mode: "single-select",
			options,
			correctIndices: resolveCorrect(input.correctAnswer, options).indices,
			explanation: input.explanation,
			createdAt: new Date().toISOString(),
		};
		const answer = buildAnswer(qd, { values: ["a"] });
		const html = renderToStaticMarkup(<AnsweredCard answer={answer} input={input} />);
		const katexCount = (html.match(/class="katex"/g) ?? []).length;
		assert.ok(katexCount >= 3, `details + option-label math renders (got ${katexCount})`);
		// Quiz options carry NO description field at all (owner ruling
		// 2026-09-26) — the desc map is ask-only and stays empty here.
		assert.ok(!html.includes("lh-prose block text-xs"), "no option-subtext slot on quiz rows");
	});

	it("legacy settled records (no input prop) render exactly as before", () => {
		const answer = buildAnswer(askQD(), { values: ["Very"] });
		const html = renderToStaticMarkup(<AnsweredCard answer={answer} />);
		assert.match(html, /Very/, "the card renders");
		assert.equal((html.match(/class="katex"/g) ?? []).length, 0, "no context slot appears from nothing");
		assert.ok(!html.includes("lh-prose block text-xs"), "no description slot without an ask input");
	});
});
