/** Seam: UpdateDetails (components/pack/update-details.tsx), rendered to static markup from a fixed UpdateState (work-wolfpack-B8vtRi3). */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UpdateDetails, feedLabel } from "../../../components/pack/update-details.tsx";
import type { UpdateState } from "../../../../../packages/protocol/src/update-state.ts";

const NOW = Date.parse("2026-11-26T12:00:00Z");
const st = (over: Partial<UpdateState> = {}): UpdateState => ({ target: "pack", host: "sfo-01", component: "hubd", state: "idle", current: "0.1.24", latest: "0.1.25", progress: null, lastCheck: "2026-11-26T11:55:00Z", channel: "main", auto: "on", ...over });
const text = (s: string) => s.replace(/<[^>]*>/g, " ").replace(/&gt;/g, ">").replace(/\s+/g, " ");

describe("UpdateDetails", () => {
	it("is a collapsed disclosure listing channel, versions, last check, auto-update and feed", () => {
		const out = renderToStaticMarkup(<UpdateDetails state={st()} feed="GitHub releases (main)" now={NOW} />);
		assert.match(out, /<details(?![^>]*\bopen\b)/);
		const t = text(out);
		assert.match(t, /Update details/);
		assert.match(t, /Channel: main/);
		assert.match(t, /0\.1\.24 → 0\.1\.25/);
		assert.match(t, /Last check: 5m ago/);
		assert.match(t, /Auto-update: on/);
		assert.match(t, /Feed: GitHub releases \(main\)/);
	});

	it("says stale and never checked in plain words", () => {
		const t = text(renderToStaticMarkup(<UpdateDetails state={st({ auto: "stale", lastCheck: null, latest: null })} feed={null} now={NOW} />));
		assert.match(t, /Auto-update: stale/);
		assert.match(t, /Last check: never/);
		assert.match(t, /0\.1\.24 → up to date/);
	});

	it("offers Roll back only when offered, and a remote machine gets the text without a button", () => {
		const on = renderToStaticMarkup(<UpdateDetails state={st()} feed={null} now={NOW} rollback={{ offered: [{ service: "hubd", to: "0.1.14" }], onRollback: () => {} }} />);
		assert.match(on, /data-testid="update-rollback-hubd"[^>]*>Roll back hubd to 0.1.14</);
		const off = renderToStaticMarkup(<UpdateDetails state={st()} feed={null} now={NOW} rollback={{ offered: [], onRollback: () => {} }} />);
		assert.doesNotMatch(off, /update-rollback/);
		const remote = renderToStaticMarkup(<UpdateDetails state={st()} feed={null} now={NOW} rollback={{ remoteText: "Roll back from that machine's console." }} />);
		assert.doesNotMatch(remote, /<button/);
		assert.match(text(remote), /Roll back from that machine(&#x27;|')s console\./);
	});

	it("shows Logs only when a handler is given", () => {
		assert.doesNotMatch(renderToStaticMarkup(<UpdateDetails state={st()} feed={null} now={NOW} />), /update-logs/);
		assert.match(renderToStaticMarkup(<UpdateDetails state={st()} feed={null} now={NOW} onLogs={() => {}} />), /data-testid="update-logs"/);
	});
});

describe("feedLabel", () => {
	it("names the GitHub feed per channel and a custom feed by host only", () => {
		assert.equal(feedLabel("app", "stable"), "GitHub releases (stable)");
		assert.equal(feedLabel("app", "main"), "GitHub releases (main)");
		assert.equal(feedLabel("app", "stable", "https://updates.example.com/path/x?k=1"), "Custom feed (updates.example.com)");
		assert.equal(feedLabel("pack", "main"), "Pack manifest (main)");
	});

	it("names no channel when it is unknown, so it does not contradict Channel: unknown", () => {
		assert.equal(feedLabel("app", null), "GitHub releases");
		assert.equal(feedLabel("pack", null), "Pack manifest");
	});
});
