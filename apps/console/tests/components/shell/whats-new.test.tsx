/**
 * Seam: What's New on open (work-wolfpack-1kIm992): the pure due rule, the once-only storage check, and the reopen button in the Pack's
 * Mac app block. Misses the dialog's browser behaviour (checked in a browser).
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { checkWhatsNew, markWhatsNewSeen, whatsNewDue, whatsNewTag } from "../../../components/shell/whats-new.tsx";
import { AppUpdateBlock } from "../../../components/pack/machine-update-details.tsx";

const mem = (init: Record<string, string> = {}) => {
	const m = new Map(Object.entries(init));
	return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe("whatsNewDue", () => {
	const table: [string | null, string, boolean][] = [
		[null, "0.2.0", false], // first run: nothing to show
		["0.2.0", "0.2.0", false],
		["0.2.0", "0.1.9", false], // rollback
		["0.2.0", "0.2.1", true],
		["0.2.0-main.3", "0.2.0-main.4", true],
		["0.2.0", "0.3.4-dev", false],
		["0.2.0", "0.3.4-dev+abc123", false],
		["0.2.0", "0.0.0", false],
		["0.2.0", "not-a-version", false],
	];
	for (const [seen, running, want] of table) it(`seen ${seen} running ${running} -> ${want}`, () => assert.equal(whatsNewDue(seen, running), want));
});

describe("what's new once per version", () => {
	it("stores silently on first run, shows after an update until dismissed", () => {
		const s = mem();
		assert.equal(checkWhatsNew(s, "console", "0.2.0"), false);
		assert.equal(s.getItem("wolfpack.whatsnew.seen.console"), "0.2.0");
		assert.equal(checkWhatsNew(s, "console", "0.2.1"), true);
		assert.equal(checkWhatsNew(s, "console", "0.2.1"), true); // not marked until dismissed
		markWhatsNewSeen(s, "console", "0.2.1");
		assert.equal(checkWhatsNew(s, "console", "0.2.1"), false);
		assert.equal(s.getItem("wolfpack.whatsnew.seen.desktop"), null);
	});
	it("names the tag by kind", () => {
		assert.equal(whatsNewTag("desktop", "0.2.1"), "desktop/v0.2.1");
		assert.equal(whatsNewTag("console", "0.1.27-main.5"), "console/v0.1.27-main.5");
	});
});

describe("reopen from the Pack", () => {
	it("the Mac app block has a What's new button", () => {
		const h = renderToStaticMarkup(<AppUpdateBlock version="0.2.1" state={null} />);
		assert.match(h, /What&#x27;s new/);
	});
});
