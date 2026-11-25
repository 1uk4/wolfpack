import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

const { registerViewRenderer, getViewRenderer, listViewKinds } = await import("../../../components/viewer/registry.tsx");
const { viewKey, parseViewKey } = await import("../../../components/viewer/view-descriptor.ts");

const props = { descriptor: { kind: "x", id: "1" }, onPush: () => {}, onTitle: () => {}, onClose: () => {} };

describe("view renderer registry", () => {
	it("returns the registered renderer for its kind", () => {
		const R = () => <b>hello</b>;
		registerViewRenderer("demo", R);
		assert.equal(getViewRenderer("demo"), R);
		assert.ok(listViewKinds().includes("demo"));
	});

	it("falls back to a No viewer message for an unknown kind", () => {
		const html = renderToStaticMarkup(React.createElement(getViewRenderer("nope"), props));
		assert.match(html, /No viewer for kind nope/);
	});

	it("round-trips view keys, ids may contain colons", () => {
		assert.equal(viewKey({ kind: "kb", id: "a:b" }), "kb:a:b");
		assert.deepEqual(parseViewKey("kb:a:b"), { kind: "kb", id: "a:b" });
		assert.equal(parseViewKey("nocolon"), null);
	});
});
