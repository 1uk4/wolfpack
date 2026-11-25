/** Seam: PromptGraphCanvas (components/settings/prompt-graph-view.tsx), static markup. A scope whose graph has no nodes (a wolfd older than the console) shows words, never a blank canvas. */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PromptGraphCanvas } from "../../../components/settings/prompt-graph-view.tsx";

describe("Prompt graph canvas", () => {
	it("says the runtime does not list per-request prompts when that graph is empty, and keeps the scope chips", () => {
		const html = renderToStaticMarkup(<PromptGraphCanvas graph={{ key: "request", title: "Per request", nodes: [], edges: [] }} selected={null} onSelect={() => {}} toolbar={<button>Memory</button>} />);
		assert.match(html, /This wolf&#x27;s runtime does not list per-request prompts yet\. Update and restart it to see them\./);
		assert.match(html, /<button>Memory<\/button>/);
	});
});
