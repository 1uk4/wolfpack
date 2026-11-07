import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { ComposerActions } from "../components/composer-actions.tsx";
import { ZeroKeysPill } from "../components/setup-cta.tsx";
import { DraftShell } from "../components/new-session.tsx";

const modelSetup = <button data-testid="setup-cta">Set up your models</button>;
const keySetup = <ZeroKeysPill inline onOpen={() => {}} />;
function documentFor(node: React.ReactNode) {
	return parseHTML(`<html><body>${renderToStaticMarkup(node)}</body></html>`).document;
}

describe("composer action row", () => {
	it("renders nothing when no action exists", () => {
		assert.equal(renderToStaticMarkup(<ComposerActions setup={false} />), "");
	});

	for (const [label, setup] of [["provider key", keySetup], ["models", modelSetup]] as const) {
		it(`${label}: setup-only renders a single button, no nested row`, () => {
			const document = documentFor(<ComposerActions setup={setup} />);
			const row = document.querySelector('[data-testid="composer-actions"]')!;
			assert.equal(row.children.length, 1);
			assert.equal(row.firstElementChild!.tagName, "BUTTON", "setup must not reserve a nested full-width row");
		});

		it(`${label}: the draft uses that same row`, () => {
			const document = documentFor(<DraftShell busy={false} text="" onChange={() => {}} onSend={() => {}} setupCta={setup} />);
			const rows = document.querySelectorAll('[data-testid="composer-actions"]');
			assert.equal(rows.length, 1);
			assert.equal(rows[0]!.lastElementChild!.tagName, "BUTTON");
		});
	}

	it("the draft shell renders no action row when nothing needs setup", () => {
		const document = documentFor(<DraftShell busy={false} text="" onChange={() => {}} onSend={() => {}} />);
		assert.equal(document.querySelector('[data-testid="composer-actions"]'), null);
	});
});
