import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const phone = css.slice(css.indexOf("@media (max-width: 767px)"));

describe("P12 pinned composer (phone CSS)", () => {
	it("locks the document and makes main the only page scroller", () => {
		assert.match(phone, /html,\s*body\s*{[^}]*overflow:\s*hidden;[^}]*overscroll-behavior:\s*none/);
		assert.match(phone, /main\s*{[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain/);
	});
	it("contains the message list scroller", () => {
		assert.match(phone, /\[role="log"\] > div\s*{[^}]*overscroll-behavior:\s*contain/);
	});
});
