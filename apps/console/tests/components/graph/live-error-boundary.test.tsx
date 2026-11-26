import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });

const { LiveErrorBoundary } = await import("../../../components/graph/live/live-error-boundary.tsx");

function Boom(): never {
	throw new Error("live layer bug");
}

describe("LiveErrorBoundary", () => {
	it("renders nothing and logs once when a live child throws, leaving siblings alone", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		const log = console.error;
		const msgs: string[] = [];
		console.error = (...a: unknown[]) => void msgs.push(String(a[0]));
		try {
			await act(async () => {
				root.render(
					<div>
						<span>graph</span>
						<LiveErrorBoundary>
							<Boom />
						</LiveErrorBoundary>
					</div>,
				);
			});
		} finally {
			console.error = log;
		}
		assert.equal(host.textContent, "graph");
		assert.equal(msgs.filter((m) => m.startsWith("live graph layer disabled")).length, 1);
		await act(async () => root.unmount());
	});
});
