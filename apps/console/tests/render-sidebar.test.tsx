/**
 * Session-row render tests — the picker's status language (owner,
 * minimal-color round): ONE indicator, the braille spinner, present ONLY
 * while a turn is in flight; every other state (idle, question pending)
 * renders nothing — question-pending is the dominant RESTING state (the
 * meta line's text carries it). Pure function of the list item, so SSR of
 * <SessionRow> pins every visible state. Same tsx classic-JSX shim as
 * render-cards.test.tsx.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionRow, timeAgo } from "../components/sidebar.tsx";
import type { ChatListItem } from "../src/core/index.ts";

function item(overrides: Partial<ChatListItem>): ChatListItem {
	return {
		id: "c1",
		title: "Test session",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
		messageCount: 4,
		pendingQuestion: false,
		busy: false,
		compacting: false,
		...overrides,
	};
}

function render(chat: ChatListItem, active = false) {
	return renderToStaticMarkup(<SessionRow chat={chat} active={active} onOpen={() => {}} />);
}

describe("SessionRow", () => {
	it("idle session: NO indicator — absence is the state", () => {
		const html = render(item({}));
		assert.ok(!html.includes("session-dot"), "no dots — the status language is spinner-only");
		assert.ok(!html.includes("braille-spinner"), "idle never shows the spinner");
	});

	it("a pending question renders NO indicator — resting state, carried by the meta text", () => {
		const html = render(item({ pendingQuestion: true }));
		assert.ok(!html.includes("session-dot"), "no dots");
		assert.ok(!html.includes("braille-spinner"), "motion is reserved for working");
		assert.ok(html.includes("Waiting for input"), "the meta line's text");
		assert.ok(!html.includes("Waiting for your answer"), "old wording is gone");
	});

	it("a working session (turn in flight) renders the braille spinner — the ONLY indicator", () => {
		const html = render(item({ busy: true }));
		assert.ok(html.includes('data-testid="braille-spinner"'), "the spinner");
		assert.ok(html.includes("braille-frame"), "CSS-animated frames");
		assert.ok((html.match(/class="braille-frame"/g) ?? []).length === 10, "all ten frames");
		assert.ok(html.includes('data-frame="0"'), "frame 0 leads (static fallback)");
		assert.ok(html.includes("Working"), "accessible label");
		assert.ok(!html.includes("bg-attention"), "no colored state fill — monochrome by design");
	});

	it("busy does not double-signal background agents (that is the sidebar section's channel)", () => {
		// The narrowing lives in the API route (busy = isTurnRunning only);
		// the row itself just renders busy faithfully. Pinned here so the
		// contract can't silently re-widen: an extraction-only "working"
		// row would be a double signal.
		const html = render(item({ busy: true, pendingQuestion: false }));
		assert.ok(html.includes("Working"), "the spinner's label names the turn, not agents");
	});

	it("the meta line: state replaces the count when the state is the useful fact", () => {
		const awaiting = render(item({ pendingQuestion: true, updatedAt: "2026-01-02T01:00:00.000Z" }));
		assert.ok(awaiting.includes(`Waiting for input · ${timeAgo("2026-01-02T01:00:00.000Z")}`), "awaiting meta keeps the age");
		assert.ok(!awaiting.includes("messages"), "count yields to the state");
		assert.ok(!awaiting.includes("braille-spinner"), "…and the spinner stays off");

		const working = render(item({ busy: true }));
		assert.ok(working.includes("Working…"), "working meta");

		// Owner, typography round 5: the message count is dropped — it
		// informed no decision. Idle meta is just how long ago.
		const idle = render(item({ title: "Partial derivatives", messageCount: 7 }));
		assert.ok(idle.includes("Partial derivatives"));
		assert.ok(!idle.includes("messages"), "the count is gone (flip-flop: one line in sessionMeta)");
		assert.match(idle, /\d{4}-\d{2}-\d{2}/, "idle shows the ISO date");
	});

	it("pending questions use the same wording with recent and old dates", () => {
		for (const updatedAt of [new Date().toISOString(), "2025-06-02T12:00:00.000Z"]) {
			const html = render(item({ pendingQuestion: true, updatedAt }));
			assert.ok(html.includes(`Waiting for input · ${timeAgo(updatedAt)}`));
			assert.ok(!html.includes("Waiting for your answer"));
		}
	});

	it("compacting retains priority over pending input", () => {
		const html = render(item({ compacting: true, pendingQuestion: true }));
		assert.match(html, /Compacting context ·/);
		assert.doesNotMatch(html, /Waiting for input/);
	});

	it("active row is visually marked by the background alone (owner, round 5: no weight change)", () => {
		const html = render(item({}), true);
		assert.ok(html.includes("bg-accent"), "active background");
		assert.ok(!html.includes("font-medium"), "weight is not a second channel doing the same job");
	});
});

describe("needs-you dot", () => {
	const waiting = () => item({ needsYou: true } as Partial<ChatListItem>);
	it("shows for a waiting thread you are not viewing", () => {
		const html = render(waiting());
		assert.match(html, /data-testid="needs-you-dot"/);
		assert.match(html, /needs you/i);
	});
	it("is hidden for the active thread (and its meta drops 'needs you')", () => {
		const html = render(waiting(), true);
		assert.doesNotMatch(html, /needs-you-dot/);
		assert.doesNotMatch(html, /needs you/i);
	});
	it("is absent once the thread is idle (status cleared)", () => {
		assert.doesNotMatch(render(item({ needsYou: false } as Partial<ChatListItem>)), /needs-you-dot/);
	});
});

describe("timeAgo", () => {
	const now = new Date("2026-01-02T12:00:00.000Z");

	it("just now / minutes / hours / days, then the ISO date (owner, round 5)", () => {
		assert.equal(timeAgo("2026-01-02T11:59:30.000Z", now), "just now");
		assert.equal(timeAgo("2026-01-02T11:55:00.000Z", now), "5m ago");
		assert.equal(timeAgo("2026-01-02T09:00:00.000Z", now), "3h ago");
		assert.equal(timeAgo("2025-12-31T12:00:00.000Z", now), "2d ago");
		assert.equal(timeAgo("2025-06-02T12:00:00.000Z", now), "2025-06-02", "beyond a week: ISO — unambiguous, sortable");
	});

	it("negative drift (clock skew) reads as just now, never a future date", () => {
		assert.equal(timeAgo("2026-01-02T12:01:00.000Z", now), "just now");
	});
});
