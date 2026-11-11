/**
 * Quiz / explain cards without the old question dock. Pending questions in a wolf thread are protocol cards rendered
 * by AskCard (single choice, with a submit); a settled quiz/explain call from older transcripts renders through
 * card-registry's QuestionCard as the graded AnsweredCard. These replace the dock-era QuizCard render tests.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { lookupCard, lookupInteractionCard } from "../components/card-registry.tsx";
import { AskCard } from "../components/ask/ask-card.tsx";
import { buildAnswer, normalizeOptions, resolveCorrect, type QuestionData } from "../src/core/question-core.ts";

type Card = import("@wolfpack/client").Card;

const quizCard: Card = {
	tool: "ask_user_question",
	fields: [
		{
			id: "answer",
			kind: "single",
			label: "Which bound is tight for typical sets, $2^{nH(X)}$?",
			options: [
				{ label: "$\\approx 2^{nH(X)}$", value: "a" },
				{ label: "Mercury", value: "b" },
			],
		},
	] as Card["fields"],
};

describe("a pending quiz-shaped question in a wolf thread", () => {
	it("renders through the interaction-card registry as an unanswered form with math in question and options", () => {
		const entry = lookupInteractionCard("ask_user_question");
		assert.ok(entry, "the retired tool's name still resolves, for old transcripts");
		assert.equal(entry!.Renderer, AskCard);
		const html = renderToStaticMarkup(<AskCard callId="c1" card={quizCard} pending submitting={false} onAnswer={() => {}} />);
		assert.ok(html.includes('data-testid="card-option"'), "options are clickable choices");
		assert.match(html, /Mercury/);
		assert.ok((html.match(/class="katex"/g) ?? []).length >= 2, "math renders in the question and an option");
		assert.ok(!html.includes("Why:"), "nothing is revealed before the answer");
	});

	it("legacy brief cards (old transcripts) still use the same renderer", () => {
		assert.equal(lookupInteractionCard("brief")?.Renderer, AskCard);
	});
});

describe("a settled quiz / explain tool call", () => {
	const input = { question: "Which planet is closest to the sun?", options: [{ label: "Venus" }, { label: "Mercury" }], correctAnswer: "Mercury", explanation: "Mercury is the innermost planet." };
	const qd = (): QuestionData => {
		const options = normalizeOptions(input.options);
		return { id: "q1", kind: "quiz", question: input.question, mode: "single-select", options, correctIndices: resolveCorrect(input.correctAnswer, options).indices, explanation: input.explanation, createdAt: new Date().toISOString() };
	};

	it("shows the graded record once answered; before that nothing (no dock to show it in)", () => {
		const Card = lookupCard("tool", "quiz")!.Renderer;
		const base = { type: "tool-quiz", toolCallId: "c1", input };
		assert.equal(renderToStaticMarkup(<Card part={{ ...base, state: "input-available" }} />), "");
		const html = renderToStaticMarkup(<Card part={{ ...base, state: "output-available", output: buildAnswer(qd(), { values: ["Venus"] }) }} />);
		assert.match(html, /closest to the sun/);
		assert.match(html, /Mercury/);
	});

	it("math in a settled quiz's options renders", () => {
		const Card = lookupCard("tool", "quiz")!.Renderer;
		const mathInput = { question: "Typical sets?", options: [{ label: "$\\approx 2^{nH(X)}$", value: "a" }, { label: "$nH(X)$", value: "b" }], correctAnswer: "a", explanation: "AEP." };
		const options = normalizeOptions(mathInput.options);
		const data: QuestionData = { id: "q2", kind: "quiz", question: mathInput.question, mode: "single-select", options, correctIndices: resolveCorrect("a", options).indices, explanation: "AEP.", createdAt: new Date().toISOString() };
		const html = renderToStaticMarkup(<Card part={{ type: "tool-quiz", toolCallId: "c2", state: "output-available", input: mathInput, output: buildAnswer(data, { values: ["$nH(X)$"] }) }} />);
		assert.ok(html.includes('class="katex"'), "option math renders");
	});
});
