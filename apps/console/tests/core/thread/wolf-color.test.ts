import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { THREAD_COLOR_KEYS } from "@wolfpack/protocol";
import { effectiveWolfColor, wolfAccentForeground, wolfColorStyle, wolfColorTokens } from "../../../src/core/thread/wolf-color.ts";

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

	it("gives the accent a readable foreground in each theme", () => {
		assert.equal(wolfAccentForeground("blue"), "light-dark(#ffffff, #0f141a)");
		assert.equal(wolfAccentForeground(undefined), "var(--primary-foreground)");
	});

	it("offers named colours, each readable as an accent in both themes", () => {
		const lum = (hex: string) => {
			const c = (i: number) => {
				const v = parseInt(hex.slice(i, i + 2), 16) / 255;
				return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
			};
			return 0.2126 * c(1) + 0.7152 * c(3) + 0.0722 * c(5);
		};
		const ratio = (a: string, b: string) => {
			const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
			return (hi! + 0.05) / (lo! + 0.05);
		};
		for (const key of THREAD_COLOR_KEYS) {
			const t = wolfColorTokens(key);
			assert.match(t.light.accent, /^#[0-9a-f]{6}$/, key);
			assert.match(t.dark.accent, /^#[0-9a-f]{6}$/, key);
			assert.ok(ratio(t.dark.accent, "#0f141a") >= 3, `${key} dark accent on the dark page`);
			assert.ok(ratio(t.light.accent, "#ffffff") >= 3, `${key} light accent on the light page`);
			const fg = /light-dark\((#[0-9a-f]{6}), (#[0-9a-f]{6})\)/.exec(wolfAccentForeground(key))!;
			assert.ok(ratio(fg[1]!, t.light.accent) >= 4.5, `${key} foreground on the light accent`);
			assert.ok(ratio(fg[2]!, t.dark.accent) >= 4.5, `${key} foreground on the dark accent`);
		}
	});

	it("exposes the pair as theme-aware css variables", () => {
		assert.deepEqual(wolfColorStyle("blue"), {
			"--wolf-tint": "light-dark(rgba(31, 111, 192, 0.07), rgba(108, 178, 242, 0.06))",
			"--wolf-accent": "light-dark(#1f6fc0, #6cb2f2)",
		});
	});
});
