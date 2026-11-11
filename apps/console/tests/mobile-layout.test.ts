import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { initialListOpen, isMobileWidth, listOpenAfterSelect, needsFloatingBack, storedListOpen, MOBILE_QUERY, keyboardShellHeight, keyboardShellTop, shellBottomInset, shouldAutoFocusComposer, trackTallestViewport, shouldResetPageScroll } from "../src/core/mobile-layout.ts";
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

test("the floating back control is hidden on the home page, where there is nothing to go back to", () => {
	assert.equal(needsFloatingBack(true, false, 0, "/"), false);
	assert.equal(needsFloatingBack(true, false, 0, "/graph"), true);
});

test("keyboardShellHeight shrinks the shell only for an open keyboard, not a small or stale viewport gap", () => {
	assert.equal(keyboardShellHeight({ height: 500.4 }, 852), 500); // keyboard open
	assert.equal(keyboardShellHeight({ height: 740 }, 852), null); // 112px short: stale/chrome, use 100dvh
	assert.equal(keyboardShellHeight({ height: 852 }, 852), null);
	assert.equal(keyboardShellHeight(null, 852), null);
});

test("keyboardShellTop follows the visual viewport's pan offset only while the keyboard is open", () => {
	assert.equal(keyboardShellTop({ height: 500, offsetTop: 120.4 }, 852), 120); // iOS panned the page: the fixed shell must move down with it
	assert.equal(keyboardShellTop({ height: 500, offsetTop: 0 }, 852), 0);
	assert.equal(keyboardShellTop({ height: 800, offsetTop: 30 }, 852), 0); // no keyboard: stay pinned to the top
	assert.equal(keyboardShellTop(null, 852), 0);
});

test("shellBottomInset drops the home-indicator inset while the keyboard is open and keeps exactly one otherwise", () => {
	assert.equal(shellBottomInset({ height: 500 }, 852), "0px"); // keyboard open: the composer sits on the keyboard
	assert.equal(shellBottomInset({ height: 740 }, 852), "env(safe-area-inset-bottom)"); // small gap: not a keyboard
	assert.equal(shellBottomInset(null, 852), "env(safe-area-inset-bottom)");
});

test("the composer takes focus on load only with a fine pointer; on a phone the keyboard would open and pan the standalone page", () => {
	assert.equal(shouldAutoFocusComposer({ coarse: true }), false);
	assert.equal(shouldAutoFocusComposer({ coarse: false }), true);
});

test("keyboard detection also works when iOS standalone shrinks innerHeight together with the visual viewport", () => {
	// standalone: keyboard opens, innerHeight 852 -> 560 and vv.height 560; the old innerHeight - vv gap is 0
	let seen = trackTallestViewport(null, 393, 852);
	seen = trackTallestViewport(seen, 393, 560);
	assert.equal(seen.height, 852);
	assert.equal(keyboardShellHeight({ height: 560 }, 560, seen.height), 560);
	assert.equal(shellBottomInset({ height: 560 }, 560, seen.height), "0px");
	// Safari / closed keyboard: unchanged
	assert.equal(keyboardShellHeight({ height: 852 }, 852, 852), null);
	assert.equal(keyboardShellHeight({ height: 740 }, 852, 852), null);
	assert.equal(keyboardShellHeight({ height: 500 }, 852), 500);
});

test("rotation resets the tallest viewport, so landscape is not read as an open keyboard", () => {
	const portrait = trackTallestViewport(null, 393, 852);
	const landscape = trackTallestViewport(portrait, 852, 393);
	assert.deepEqual(landscape, { width: 852, height: 393 });
	assert.equal(keyboardShellHeight({ height: 393 }, 393, landscape.height), null);
});

test("the page scroll iOS adds when the keyboard opens is undone, so the pinned shell and its header stay on screen", () => {
	assert.equal(shouldResetPageScroll(true, 120), true); // keyboard open, document scrolled: reset
	assert.equal(shouldResetPageScroll(true, 0), false); // already at the top: no write
	assert.equal(shouldResetPageScroll(false, 120), false); // keyboard closed: never touch the scroll
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
