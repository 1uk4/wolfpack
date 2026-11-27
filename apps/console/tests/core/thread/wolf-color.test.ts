import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { THREAD_COLOR_KEYS } from "@wolfpack/protocol";
import { effectiveWolfColor, wolfColorStyle, wolfColorTokens } from "../../../src/core/thread/wolf-color.ts";

describe("wolf colour tokens", () => {
	it("maps a known key to its light and dark tint and accent", () => {
		assert.deepEqual(wolfColorTokens("blue"), {
			light: { tint: "rgba(31, 111, 192, 0.07)", accent: "#1f6fc0" },
			dark: { tint: "rgba(108, 178, 242, 0.06)", accent: "#6cb2f2" },
		});
	});

	it("falls back to the neutral pair for a missing or unknown key", () => {
		const neutral = { light: { tint: "transparent", accent: "var(--primary)" }, dark: { tint: "transparent", accent: "var(--primary)" } };
		assert.deepEqual(wolfColorTokens(undefined), neutral);
		assert.deepEqual(wolfColorTokens("chartreuse"), neutral);
	});

	it("covers every thread colour key with a non-neutral pair", () => {
		for (const key of THREAD_COLOR_KEYS) {
			const t = wolfColorTokens(key);
			assert.match(t.dark.tint, /^rgba\(/, key);
			assert.match(t.light.tint, /^rgba\(/, key);
			assert.match(t.light.accent, /^#[0-9a-f]{6}$/, key);
		}
	});

	it("gives a wolf with no config colour the colour the den strip shows, and lets the config win", () => {
		assert.equal(effectiveWolfColor({ name: "1uk4" }), "yellow");
		assert.equal(effectiveWolfColor({ name: "hal" }), "teal");
		assert.equal(effectiveWolfColor({ name: "hal", color: "pink" }), "pink");
		assert.equal(effectiveWolfColor({ name: "hal", color: "chartreuse" }), "teal");
	});

	it("exposes the pair as theme-aware css variables", () => {
		assert.deepEqual(wolfColorStyle("blue"), {
			"--wolf-tint": "light-dark(rgba(31, 111, 192, 0.07), rgba(108, 178, 242, 0.06))",
			"--wolf-accent": "light-dark(#1f6fc0, #6cb2f2)",
		});
	});
});
