import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { initialListOpen, isMobileWidth, listOpenAfterNavigation, MOBILE_BREAKPOINT, MOBILE_QUERY, visibleHeight } from "../src/core/mobile-layout.ts";
import manifest from "../app/manifest.ts";

test("breakpoint: 767 is a phone, 768 is desktop (matches Tailwind md and the CSS @media)", () => {
	assert.equal(isMobileWidth(767), true);
	assert.equal(isMobileWidth(768), false);
	assert.equal(MOBILE_QUERY, "(max-width: 767px)");
	assert.match(readFileSync(new URL("../app/globals.css", import.meta.url), "utf8"), new RegExp(`@media \\(max-width: ${MOBILE_BREAKPOINT - 1}px\\)`));
});

test("a phone starts on the list; desktop follows the stored preference", () => {
	assert.equal(initialListOpen(true, "0"), true);
	assert.equal(initialListOpen(true, null, "/wolf/hal2/thread/t1"), false, "a deep link shows the content, not the list");
	assert.equal(initialListOpen(false, "0"), false);
	assert.equal(initialListOpen(false, "1"), true);
	assert.equal(initialListOpen(false, null), true);
});

test("navigating on a phone closes the list; first render, same path and desktop do not", () => {
	assert.equal(listOpenAfterNavigation(true, true, null, "/"), true);
	assert.equal(listOpenAfterNavigation(true, true, "/", "/"), true);
	assert.equal(listOpenAfterNavigation(true, true, "/", "/wolf/hal2/thread/t1"), false);
	assert.equal(listOpenAfterNavigation(true, true, "/wolf/hal2/thread/t1", "/pipeline"), false);
	assert.equal(listOpenAfterNavigation(false, true, "/", "/wolf/hal2/thread/t1"), true);
	assert.equal(listOpenAfterNavigation(false, false, "/", "/x"), false);
});

test("visibleHeight prefers the visualViewport (keyboard) and falls back to innerHeight", () => {
	assert.equal(visibleHeight({ height: 500.4 }, 844), 500);
	assert.equal(visibleHeight(null, 844), 844);
});

test("manifest: installable, theme matches the console, icons exist on disk", () => {
	const m = manifest();
	assert.equal(m.display, "standalone");
	assert.equal(m.start_url, "/");
	assert.ok(m.name && m.short_name);
	assert.equal(m.background_color, "#141414");
	assert.equal(m.theme_color, "#141414");
	const sizes = new Set((m.icons ?? []).map((i) => i.sizes));
	assert.ok(sizes.has("192x192") && sizes.has("512x512"));
	for (const i of m.icons ?? []) assert.ok(existsSync(new URL(`../public${i.src}`, import.meta.url)), i.src);
});
