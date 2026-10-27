import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EntryReaderView, entryReaderState } from "../components/entry-reader.tsx";
import { KbMarkdown } from "../components/kb-markdown.tsx";
import { WorkItemView } from "../components/work-item-page.tsx";

const ENTRY = {
	id: "e1",
	title: "Entry One",
	domain: "wolfpack",
	frontmatter: { maturity: "stable", authority: "curated", kind: "concept", related: ["e3"] },
	body: "Hello [[e2|Two]] and [[nope]].\n",
	wikilinks: [
		{ target: "e2", exists: true },
		{ target: "nope", exists: false },
	],
	backlinks: [{ id: "e4", title: "Four", via: "wikilink" as const }],
};

describe("EntryReader (SSR)", () => {
	it("renders facts, resolved + unresolved wikilinks, related, backlinks", () => {
		const html = renderToStaticMarkup(<EntryReaderView id="e1" state={entryReaderState({ ok: true, data: ENTRY })} />);
		assert.match(html, /Entry One/);
		assert.match(html, /data-crumb="domain"/);
		assert.match(html, /data-fact="maturity"/);
		assert.match(html, /href="\/kb\/entry\/e2"[^>]*>Two</);
		assert.match(html, /data-unresolved="true"[^>]*>nope</);
		assert.match(html, /href="\/kb\/entry\/e3"/);
		assert.match(html, /data-via="wikilink"/);
	});
	it("shows unavailable / not-found / loading states", () => {
		const r = (state: Parameters<typeof EntryReaderView>[0]["state"]) => renderToStaticMarkup(<EntryReaderView id="x" state={state} />);
		assert.match(r(entryReaderState({ ok: false, reason: "unavailable", message: "" })), /unavailable/);
		assert.match(r(entryReaderState({ ok: false, reason: "not_found", message: "" })), /No entry/);
		assert.match(r({ kind: "loading" }), /Loading/);
	});
});

describe("KbMarkdown (SSR)", () => {
	it("stamps heading ids, keeps # anchors in-tab, renders relative links as text", () => {
		const html = renderToStaticMarkup(
			<KbMarkdown>{"## My_Head, ok\n\n## ?!\n\n[up](#my_head-ok) [rel](./x.md) [ext](https://e.com)"}</KbMarkdown>,
		);
		assert.match(html, /<h2[^>]*id="my_head-ok"/);
		assert.doesNotMatch(html, /<h2[^>]*id=""/);
		assert.match(html, /<a href="#my_head-ok"(?![^>]*target)/);
		// streamdown resolves ./x.md to /x.md; it must not open a new tab
		assert.doesNotMatch(html, /target="_blank"[^>]*href="\/x\.md"|href="\/x\.md"[^>]*target/);
		assert.match(html, /href="https:\/\/e\.com\/" target="_blank"/);
	});
});

describe("WorkItemPage (SSR)", () => {
	const item = { id: "t1", title: "Task", kind: "task", stage: "in_build", domain: "wolfpack", partOf: "f1", dependsOn: ["t0"], plan: "do it", record: "" };
	it("shows parent/dependency links and the parent's Record when own is empty", () => {
		const html = renderToStaticMarkup(
			<WorkItemView id="t1" state={{ kind: "ready", item, parent: { ...item, id: "f1", title: "Feat", kind: "feature", partOf: null, dependsOn: [], record: "parent notes" } }} />,
		);
		assert.match(html, /href="\/kb\/work\/f1"/);
		assert.match(html, /href="\/kb\/work\/t0"/);
		assert.match(html, /Record \(from parent feature/);
		assert.match(html, /parent notes/);
	});
	it("a feature renders its task graph above the plan; a task renders none", () => {
		const kid = (id: string, stage: string, dependsOn: string[] = []) => ({ id, title: `Task ${id}`, kind: "task", stage, dependsOn });
		const feat = { id: "F", title: "Feat", kind: "feature", stage: "in_build", domain: "wolfpack", partOf: null, dependsOn: [], plan: "the plan", record: "", children: [kid("a", "shipped"), kid("b", "idea", ["a"])] };
		const html = renderToStaticMarkup(<WorkItemView id="F" state={{ kind: "ready", item: feat, parent: null }} />);
		assert.match(html, /data-section="tasks"/);
		assert.match(html, /1\/2 shipped/);
		assert.match(html, /data-testid="task-node-a" data-status="shipped"/);
		assert.ok(html.indexOf('data-section="tasks"') < html.indexOf('data-section="plan"'));
		const task = renderToStaticMarkup(<WorkItemView id="t" state={{ kind: "ready", item: { ...feat, id: "t", kind: "task", children: undefined }, parent: null }} />);
		assert.doesNotMatch(task, /data-section="tasks"/);
	});
});
