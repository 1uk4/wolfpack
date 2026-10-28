/** The overlay header's traffic-lights gutter, shared by the task graph and the subagent modal. */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

const { OverlayHeader, OverlayShell, OVERLAY_HEADER_CLASS } = await import("../components/overlay-shell.tsx");

describe("OverlayShell header", () => {
	it("OverlayHeader carries the lights gutter and drag classes and cancels the overlay padding", () => {
		for (const c of ["lh-lights-gutter", "lh-drag", "-ml-4"]) assert.ok(OVERLAY_HEADER_CLASS.split(" ").includes(c), c);
		const html = renderToStaticMarkup(
			<OverlayShell label="x" testId="o" closeTestId="o-close" onClose={() => {}} header={(close) => <OverlayHeader>{close}</OverlayHeader>}>
				<div />
			</OverlayShell>,
		);
		assert.match(html, /<div[^>]*class="[^"]*lh-lights-gutter[^"]*"[^>]*data-overlay-header[^>]*>.*data-testid="o-close"/);
	});

	it("the task graph overlay header uses it", () => {
		assert.match(readFileSync(new URL("../components/task-graph.tsx", import.meta.url), "utf8"), /<OverlayHeader[\s>]/);
	});
});
