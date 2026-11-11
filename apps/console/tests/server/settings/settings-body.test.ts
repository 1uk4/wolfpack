/**
 * Tests for the section parsers (settings-storage wave, 2026-09-19):
 * src/server/settings-body.ts — general/agent/appearance strictness.
 * Same discipline as parseSettingsBody (its tests live in
 * default-settings.test.ts): every known field is strict (bad type/shape
 * → 400-style error, never a silent clamp), unknown keys drop, absent
 * fields mean absent overrides. Pure — no fs.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	parseModelsSettingsBody,
	parseAppearanceSettingsBody,
	SETTINGS_SECTIONS,
} from "../../../src/server/settings/settings-body.ts";

describe("parseAppearanceSettingsBody", () => {
	it("parses every field; hex-or-null colors; clamps happen at sanitize, rejects here", () => {
		const r = parseAppearanceSettingsBody({
			mode: "light",
			background: "#ffffff",
			fontFamily: "Some Font",
			proseFontSize: 20,
			sessionNameSerif: false,
			mdRendering: { headingWeight: 700, boldColor: "#ff8800", italicColor: null },
		});
		assert.ok(r.ok);
		assert.deepEqual(r.settings, {
			mode: "light",
			background: "#ffffff",
			fontFamily: "Some Font",
			proseFontSize: 20,
			sessionNameSerif: false,
			mdRendering: { headingWeight: 700, boldColor: "#ff8800", italicColor: null },
		});
	});

	it("rejects bad enums, ranges, and colors — with specific messages, never clamps", () => {
		const cases: unknown[] = [
			{ mode: "sepia" },
			{ background: "blue" },
			{ background: 42 },
			{ fontFamily: "" },
			{ fontFamily: 12 },
			{ proseFontSize: 30 },
			{ proseFontSize: 64.5 },
			{ sessionNameSerif: 1 },
			{ mdRendering: { headingWeight: 1000 } },
			{ mdRendering: { boldColor: "red" } },
		];
		for (const body of cases) {
			assert.equal(parseAppearanceSettingsBody(body).ok, false, JSON.stringify(body));
		}
		// boundary values that MUST pass: 12 and 24, 100 and 900, #fff
		assert.ok(parseAppearanceSettingsBody({ proseFontSize: 12 }));
		assert.ok(parseAppearanceSettingsBody({ proseFontSize: 24 }));
		assert.ok(parseAppearanceSettingsBody({ mdRendering: { headingWeight: 100 } }));
		assert.ok(parseAppearanceSettingsBody({ mdRendering: { headingWeight: 900 } }));
		assert.ok(parseAppearanceSettingsBody({ background: "#abc" }));
		// null = "the mode's default" — explicit, valid
		assert.ok(parseAppearanceSettingsBody({ background: null, fontFamily: null }));
	});

	it("rejects non-object bodies and non-object mdRendering", () => {
		assert.equal(parseAppearanceSettingsBody([1]).ok, false);
		assert.equal(parseAppearanceSettingsBody({ mdRendering: "big" }).ok, false);
	});
});

describe("SETTINGS_SECTIONS (the route's section map)", () => {
	it("maps exactly the three record sections", () => {
		assert.deepEqual(
			Object.keys(SETTINGS_SECTIONS),
			["chat", "appearance", "models"],
		);
	});
});

describe("parseModelsSettingsBody (model slots wave, 2026-09-20)", () => {
	it("parses the three slot tiers — model required, level rides (BYOK, owner 2026-09-22)", () => {
		const r = parseModelsSettingsBody({
			strong: { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } },
			cheap: { model: { provider: "zai", id: "glm-5.3-flash" }, thinkingLevel: "high" },
			vision: { model: { provider: "zai", id: "glm-5.3-flash" }, thinkingLevel: "low" },
		});
		assert.ok(r.ok);
		assert.deepEqual(r.settings, {
			strong: { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } },
			cheap: { model: { provider: "zai", id: "glm-5.3-flash" }, thinkingLevel: "high" },
			vision: { model: { provider: "zai", id: "glm-5.3-flash" }, thinkingLevel: "low" },
		});
		// a thinkingLevel WITHOUT a model can never run (no factory floor)
		const levelOnly = parseModelsSettingsBody({ cheap: { thinkingLevel: "high" } });
		assert.equal(levelOnly.ok, false);
		if (!levelOnly.ok) {
			assert.match(levelOnly.error, /slot "cheap" must set a model/);
		}
	});

	it("{} is the legal clear-slots write", () => {
		const r = parseModelsSettingsBody({});
		assert.ok(r.ok);
		assert.deepEqual(r.settings, {});
	});

	it("unknown slots are 400s with the supported list", () => {
		const bad = parseModelsSettingsBody({ mega: { thinkingLevel: "high" } });
		assert.equal(bad.ok, false);
		if (!bad.ok) assert.match(bad.error, /unknown slot "mega" \(supported: strong, cheap, vision\)/);
	});

	it("a present-but-empty slot object is rejected (absent slot = unset)", () => {
		const bad = parseModelsSettingsBody({ strong: {} });
		assert.equal(bad.ok, false);
		if (!bad.ok) assert.match(bad.error, /slot "strong" must set a model/);
	});

	it("malformed slot shapes are 400s", () => {
		assert.equal(parseModelsSettingsBody({ cheap: { model: { provider: "x" } } }).ok, false);
		assert.equal(parseModelsSettingsBody({ vision: { thinkingLevel: 7 } }).ok, false);
		assert.equal(parseModelsSettingsBody("nope").ok, false);
	});
});
