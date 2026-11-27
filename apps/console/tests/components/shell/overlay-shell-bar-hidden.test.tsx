/**
 * Seam: OverlayShell (the full-window overlay of the task graph, plan focus, git tree and sub-agent modal) x the floating chat bar's
 * hide reasons. Catches: the bar staying drawn over a full-window overlay, or staying hidden after it closes.
 * Misses: the pixel stacking (z-index), checked in the browser.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const { OverlayShell } = await import("../../../components/shell/overlay-shell.tsx");
const { useBarHiddenReasons } = await import("../../../components/chat-bar/bar-visibility.ts");
const { barHiddenFor } = await import("../../../src/core/ui/bar-visibility.ts");

let hidden: boolean | null = null;
function Probe() {
	hidden = barHiddenFor("/graph", { reasons: useBarHiddenReasons() });
	return null;
}

describe("a full-window overlay hides the floating chat bar", () => {
	const host = dom.document.createElement("div");
	dom.document.body.appendChild(host);
	const root = createRoot(host as unknown as Element);
	after(() => act(() => root.unmount()));

	it("hides the bar while the overlay is open and shows it again once it closes", async () => {
		await act(async () => root.render(<Probe />));
		assert.equal(hidden, false);
		await act(async () => root.render(<><Probe /><OverlayShell label="Tasks" testId="o" closeTestId="c" onClose={() => {}}>body</OverlayShell></>));
		assert.equal(hidden, true);
		await act(async () => root.render(<Probe />));
		assert.equal(hidden, false);
	});
});
