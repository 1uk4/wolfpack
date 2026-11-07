import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { initialListOpen, isMobileWidth, listOpenAfterSelect, needsFloatingBack, storedListOpen, MOBILE_QUERY, visibleHeight } from "../src/core/mobile-layout.ts";
import manifest from "../app/manifest.ts";

test("breakpoint: 767 is a phone, 768 is desktop (matches Tailwind md and the CSS @media)", () => {
	assert.equal(isMobileWidth(767), true);
	assert.equal(isMobileWidth(768), false);
	assert.equal(MOBILE_QUERY, "(max-width: 767px)");
});

test("a phone starts on the list; desktop follows the stored preference", () => {
	assert.equal(initialListOpen(true, "0"), true);
	assert.equal(initialListOpen(true, null, "/wolf/hal2/thread/t1"), false, "a deep link shows the content, not the list");
	assert.equal(initialListOpen(false, "0"), false);
	assert.equal(initialListOpen(false, "1"), true);
	assert.equal(initialListOpen(false, null), true);
});

test("selecting in the list closes it on a phone even when the route does not change; desktop is untouched", () => {
	// the same-route tap: no pathname change is involved at all, the click handler decides
	assert.equal(listOpenAfterSelect(true, true), false);
	assert.equal(listOpenAfterSelect(false, true), true);
	assert.equal(listOpenAfterSelect(false, false), false);
});

test("rotation / resize: crossing 768 recomputes; desktop restores the stored preference", () => {
	assert.equal(initialListOpen(true, "0", "/"), true); // desktop(closed) -> phone at "/"
	assert.equal(initialListOpen(false, "0", "/x"), false); // phone -> desktop restores the stored "closed"
	assert.equal(initialListOpen(false, "1", "/x"), true);
	assert.equal(storedListOpen(null), true);
});

test("the floating back control shows only on a phone, list closed, with no SidebarToggle on the page", () => {
	assert.equal(needsFloatingBack(true, false, 0), true);
	assert.equal(needsFloatingBack(true, false, 1), false);
	assert.equal(needsFloatingBack(true, true, 0), false);
	assert.equal(needsFloatingBack(false, false, 0), false);
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
	assert.equal(m.background_color, "#0f141a");
	assert.equal(m.theme_color, "#0f141a");
	const sizes = new Set((m.icons ?? []).map((i) => i.sizes));
	assert.ok(sizes.has("192x192") && sizes.has("512x512"));
	for (const i of m.icons ?? []) assert.ok(existsSync(new URL(`../public${i.src}`, import.meta.url)), i.src);
});
