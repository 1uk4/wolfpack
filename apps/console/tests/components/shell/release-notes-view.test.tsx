/**
 * Seam: ReleaseNotesView (work-wolfpack-DKce6er), the GitHub release body rendered in the app. Catches: a release body linking to a
 * non-web scheme (javascript:, data:), a remote image loading from the notes, raw HTML passing through. Misses: browser click behaviour.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ReleaseNotesView } from "../../../components/shell/release-notes-view.tsx";

const render = (body: string) => renderToStaticMarkup(<ReleaseNotesView state={{ body, url: "https://github.com/1uk4/wolfpack/releases/tag/x" }} />);

describe("release notes view", () => {
	it("keeps https and mailto links and drops javascript: and data: hrefs", () => {
		const html = render("[ok](https://example.com/a) [mail](mailto:a@b.co) [bad](javascript:alert(1)) [data](data:text/html,x)");
		assert.match(html, /href="https:\/\/example\.com\/a"/);
		assert.match(html, /href="mailto:a@b\.co"/);
		assert.doesNotMatch(html, /javascript:/i);
		assert.doesNotMatch(html, /href="data:/i);
		assert.match(html, /bad/); // the text stays
	});

	it("does not load remote images and does not pass raw HTML through", () => {
		const html = render("![shot](https://evil.example/pixel.png)\n\n<img src=\"https://evil.example/raw.png\" onerror=\"x()\"><script>alert(1)</script>");
		assert.doesNotMatch(html, /<img/i);
		assert.doesNotMatch(html, /<script/i);
		assert.doesNotMatch(html, /evil\.example\/pixel/);
	});
});
