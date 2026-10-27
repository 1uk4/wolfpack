import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	UNRESOLVED_HREF,
	entryBreadcrumb,
	entryFacts,
	entryRelated,
	groupBacklinks,
	headingSlug,
	parseWikilink,
	rewriteWikilinks,
} from "../src/core/entry-view.ts";

describe("parseWikilink", () => {
	it("handles plain, alias, heading and heading+alias", () => {
		assert.deepEqual(parseWikilink("a"), { target: "a" });
		assert.deepEqual(parseWikilink("a|Alias"), { target: "a", alias: "Alias" });
		assert.deepEqual(parseWikilink("a#Some Head"), { target: "a", heading: "Some Head" });
		assert.deepEqual(parseWikilink(" a#H | Al "), { target: "a", heading: "H", alias: "Al" });
		assert.equal(parseWikilink("#only"), null);
	});
});

describe("rewriteWikilinks", () => {
	const links = [
		{ target: "a", exists: true },
		{ target: "gone", exists: false },
	];
	it("links existing targets, marks missing ones unresolved", () => {
		assert.equal(rewriteWikilinks("see [[a]] and [[gone]]", links), `see [a](/kb/entry/a) and [gone](${UNRESOLVED_HREF})`);
	});
	it("applies alias and heading anchor", () => {
		assert.equal(rewriteWikilinks("[[a|The A]] [[a#My Head]]", links), "[The A](/kb/entry/a) [a › My Head](/kb/entry/a#my-head)");
	});
	it("leaves code fences and inline code alone", () => {
		const src = "`[[a]]` x [[a]]\n```\n[[a]]\n```\n[[a]]";
		assert.equal(rewriteWikilinks(src, links), "`[[a]]` x [a](/kb/entry/a)\n```\n[[a]]\n```\n[a](/kb/entry/a)");
	});
	it("slugs headings, keeping underscores", () => {
		assert.equal(headingSlug("Hello, World 2"), "hello-world-2");
		assert.equal(headingSlug("snake_case Head"), "snake_case-head");
		assert.equal(headingSlug("?!"), "");
	});
	it("percent-encodes parens in ids; drops an empty-slug fragment", () => {
		const l = [{ target: "a(b)", exists: true }];
		assert.equal(rewriteWikilinks("[[a(b)]] [[a(b)#?!]]", l), "[a(b)](/kb/entry/a%28b%29) [a(b) › ?\\!](/kb/entry/a%28b%29)");
	});
	it("escapes markdown in aliases", () => {
		assert.equal(rewriteWikilinks("[[a|*x*_y_`z<b>!]]", links), "[\\*x\\*\\_y\\_\\`z\\<b>\\!](/kb/entry/a)");
	});
	it("skips ~~~ fences, honours longer closers, ignores a closer with an info string", () => {
		assert.equal(rewriteWikilinks("~~~\n[[a]]\n~~~\n[[a]]", links), "~~~\n[[a]]\n~~~\n[a](/kb/entry/a)");
		assert.equal(rewriteWikilinks("```\n[[a]]\n`````\n[[a]]", links), "```\n[[a]]\n`````\n[a](/kb/entry/a)");
		assert.equal(rewriteWikilinks("```\n```js\n[[a]]\n```\n[[a]]", links), "```\n```js\n[[a]]\n```\n[a](/kb/entry/a)");
		assert.equal(rewriteWikilinks("````\n```\n[[a]]\n```", links), "````\n```\n[[a]]\n```");
	});
	it("an unclosed fence runs to the end", () => {
		assert.equal(rewriteWikilinks("```\n[[a]]\n[[a]]", links), "```\n[[a]]\n[[a]]");
	});
	it("skips indented code blocks but not indented continuations of prose", () => {
		assert.equal(rewriteWikilinks("text\n\n    [[a]]\n    [[a]]\n\n[[a]]", links), "text\n\n    [[a]]\n    [[a]]\n\n[a](/kb/entry/a)");
		assert.equal(rewriteWikilinks("text\n    [[a]]", links), "text\n    [a](/kb/entry/a)");
	});
	it("inline code needs equal-length delimiters", () => {
		assert.equal(rewriteWikilinks("``[[a]]`` [[a]]", links), "``[[a]]`` [a](/kb/entry/a)");
		assert.equal(rewriteWikilinks("`` [[a]] ` [[a]]", links), "`` [a](/kb/entry/a) ` [a](/kb/entry/a)");
	});
});

describe("frontmatter views", () => {
	it("entryFacts keeps display order and skips absent/non-scalar", () => {
		assert.deepEqual(entryFacts({ authority: "curated", maturity: "stable", kind: "concept", currency: { x: 1 } }), [
			{ key: "kind", value: "concept" },
			{ key: "maturity", value: "stable" },
			{ key: "authority", value: "curated" },
		]);
	});
	it("breadcrumb is domain then optional section", () => {
		assert.deepEqual(entryBreadcrumb({ domain: "wolfpack", frontmatter: {} }), [{ label: "wolfpack", kind: "domain" }]);
		assert.equal(entryBreadcrumb({ domain: "wolfpack", frontmatter: { section: "memory" } })[1]?.label, "memory");
	});
	it("entryRelated reads strings and objects, deduped", () => {
		assert.deepEqual(entryRelated({ related: ["x", { target: "y", kind: "supersedes" }], relations: ["x"] }), [
			{ target: "x", relation: "see_also" },
			{ target: "y", relation: "supersedes" },
		]);
	});
	it("groupBacklinks groups by via, wikilink first, drops empty", () => {
		const g = groupBacklinks([
			{ id: "r", title: "R", via: "related", relation: "see_also" },
			{ id: "w", title: "W", via: "wikilink" },
		]);
		assert.deepEqual(g.map((x) => x.via), ["wikilink", "related"]);
		assert.equal(groupBacklinks([{ id: "w", title: "W", via: "wikilink" }]).length, 1);
	});
});
