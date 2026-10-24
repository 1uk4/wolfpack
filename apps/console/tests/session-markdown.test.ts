/**
 * The session-markdown engine (core/session-markdown.ts): the session
 * export's one renderer — id-anchored speaker blocks, readable
 * quiz/recall/question blocks, one-line notes for other tools. Pinned here:
 * block shapes, anchor handling (on/off), title header, empty-message
 * skipping.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LhMessage } from "../src/core/native-messages.ts";
import { messageMarkdown, sessionMarkdown } from "../src/core/session-markdown.ts";

function user(id: string, text: string): LhMessage {
	return { id, role: "user", content: text, timestamp: Date.now() } as never;
}

function teacher(id: string, text: string): LhMessage {
	return {
		id,
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openrouter",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason: "stop",
		timestamp: Date.now(),
	} as never;
}

function result(
	id: string,
	toolCallId: string,
	toolName: string,
	details: unknown,
	isError = false,
): LhMessage {
	return {
		id,
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "ok" }],
		details,
		isError,
		timestamp: Date.now(),
	} as never;
}

describe("messageMarkdown", () => {
	it("renders speaker blocks with the id anchor", () => {
		const md = messageMarkdown(user("u1", "help me with the chain rule"), "u1");
		assert.equal(md, "### User · u1\n\nhelp me with the chain rule");
		const md2 = messageMarkdown(teacher("a1", "The derivative measures change."), "a1");
		assert.equal(md2, "### Assistant · a1\n\nThe derivative measures change.");
	});

	it("anchors off — the same document without the ids (the user export)", () => {
		const md = messageMarkdown(user("u1", "hello"), "u1", false);
		assert.equal(md, "### User\n\nhello");
	});

	it("quiz blocks: question + outcome + the note", () => {
		const md = messageMarkdown(
			result("r1", "q1", "quiz", { questionText: "What is a derivative?", correct: false, dontKnow: false, note: "mixed up signs" }),
			"r1",
		)!;
		assert.match(md, /^### Quiz · r1$/m);
		assert.match(md, /\*\*Q:\*\* What is a derivative\?/);
		assert.match(md, /The user answered incorrectly\./);
		assert.match(md, /\*\(their note: mixed up signs\)\*/);
	});

	it("explain results: the user's own words are shown", () => {
		const md = messageMarkdown(
			result("r1", "e1", "explain", { questionText: "Why does Mercury stay near the Sun?", text: "it never strays far" }),
			"r1",
		)!;
		assert.match(md, /^### Recall check · r1$/m);
		assert.match(md, /The user answered in their own words: it never strays far/);
	});

	it("ask blocks: question + chosen options + free text", () => {
		const chosen = messageMarkdown(
			result("r1", "a1", "ask_user_question", { questionText: "Which way?", answers: ["second"], other: "also the third" }),
			"r1",
		)!;
		assert.match(chosen, /^### Question · r1$/m);
		assert.match(chosen, /The user chose: second, also the third/);
		const free = messageMarkdown(
			result("r2", "a2", "ask_user_question", { questionText: "Why?", text: "because" }),
			"r2",
		)!;
		assert.match(free, /The user answered: because/);
	});

	it("other clean tool results: one line; failed calls and markers: nothing", () => {
		assert.equal(messageMarkdown(result("r1", "j1", "research", { brief: "long" }), "r1"), "### Tool · r1\n\n*research result delivered*");
		assert.equal(messageMarkdown(result("r2", "j2", "research", {}, true), "r2"), null, "a failed call is retry context");
		assert.equal(messageMarkdown(user("u3", "   "), "u3"), null, "empty text renders nothing");
	});
});

describe("sessionMarkdown", () => {
	it("assembles blocks in order under the title header, skipping nothings", () => {
		const md = sessionMarkdown([user("u1", "go"), teacher("a1", "First."), user("u2", "  ")], { title: "My session" });
		assert.equal(md, "# My session\n\n### User · u1\n\ngo\n\n### Assistant · a1\n\nFirst.");
	});

	it("no title → no header; anchors default on", () => {
		const md = sessionMarkdown([user("u1", "go")]);
		assert.equal(md, "### User · u1\n\ngo");
	});
});
