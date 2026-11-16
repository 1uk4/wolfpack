import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TopicFacts } from "../../../components/memory/topic-page.tsx";

describe("Topic page frontmatter", () => {
	it("shows the state chip with the reason as tooltip and links each KB entry id to its page", () => {
		const html = renderToStaticMarkup(
			<TopicFacts topic={{ id: "a", title: "A", bytes: 2048, updated: "2026-11-13 10:00", sources: ["thread:abc"], state: "held", reason: "distill: log-like", keepLocal: false, entryIds: ["e1", "e2"] }} />,
		);
		assert.match(html, /data-testid="topic-chip"[^>]*>held</);
		assert.match(html, /title="distill: log-like"/);
		assert.match(html, /href="\/kb\/entry\/e1"/);
		assert.match(html, /href="\/kb\/entry\/e2"/);
		assert.match(html, /2\.0 KB/);
	});
});
