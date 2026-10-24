/**
 * Tests for the resolution layer (settings-storage wave, 2026-09-19;
 * model-slots wave 2026-09-20; BYOK all-the-way-down wave 2026-09-22):
 * core/settings-resolution.ts — the delta→concrete projection. There are
 * NO factory pins: a model chain that ends empty resolves to null, and the
 * per-need refusal gate (the turn gate) fires on exactly that.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveConversationSpec, resolveSettings, resolveSlot } from "../src/core/settings-resolution.ts";
import type { UserSettings } from "../src/core/settings.ts";

describe("resolveSettings", () => {
	it("null record (first boot): non-model knobs land on factory defaults; every model view is EMPTY", () => {
		const eff = resolveSettings(null);
		assert.deepEqual(eff.general, { autoUpdate: true });
		assert.deepEqual(eff.agent.prompts, {});
		// BYOK (owner, 2026-09-22): no factory floor — every slot null. No
		// phantom ids anywhere.
		assert.equal(eff.models.strong, null);
		assert.equal(eff.models.cheap, null);
		assert.equal(eff.models.vision, null);
		assert.equal(eff.appearance.mode, "dark");
		assert.equal(eff.appearance.background, null);
		assert.equal(eff.appearance.fontFamily, null);
		assert.equal(eff.appearance.proseFontSize, 16);
		assert.equal(eff.appearance.sessionNameSerif, true);
		assert.equal(eff.appearance.mdRendering.headingWeight, 900);
		assert.deepEqual(eff.compaction, { thresholdTokens: 150_000 });
	});

	it("explicit record values win over every factory default", () => {
		const record: UserSettings = {
			version: 1,
			general: { autoUpdate: false },
			agent: { prompts: { "system-prompt.md": true } },
			appearance: { mode: "light", proseFontSize: 20, mdRendering: { headingWeight: 600 } },
			compaction: { thresholdTokens: 64_000 },
		};
		const eff = resolveSettings(record);
		assert.equal(eff.general.autoUpdate, false);
		assert.deepEqual(eff.agent.prompts, { "system-prompt.md": true });
		assert.equal(eff.appearance.mode, "light");
		assert.equal(eff.appearance.proseFontSize, 20);
		assert.equal(eff.appearance.mdRendering.headingWeight, 600);
		assert.deepEqual(eff.compaction, { thresholdTokens: 64_000 });
	});
});

describe("the slot tier (BYOK, owner 2026-09-22)", () => {
	it("each slot resolves to its own tier; level-only slots resolve as NULL", () => {
		const eff = resolveSettings({ version: 1, models: { vision: { model: { provider: "zai", id: "v-model" }, thinkingLevel: "max" } } });
		assert.deepEqual(eff.models.vision, { provider: "zai", id: "v-model", thinkingLevel: "max" });
		assert.equal(eff.models.cheap, null);
		// a stored level WITHOUT a model is inert (kept on disk, no phantom default)
		const inert = resolveSettings({ version: 1, models: { strong: { thinkingLevel: "medium" } } });
		assert.equal(inert.models.strong, null);
	});

	it("resolveSlot: configured iff the model is present", () => {
		assert.deepEqual(resolveSlot({ model: { provider: "zai", id: "m" }, thinkingLevel: "medium" }), {
			provider: "zai",
			id: "m",
			thinkingLevel: "medium",
		});
		assert.deepEqual(resolveSlot({ model: { provider: "zai", id: "m" } }), {
			provider: "zai",
			id: "m",
			thinkingLevel: undefined, // unset → resolved from the default order at build
		});
		assert.equal(resolveSlot({ thinkingLevel: "medium" }), null);
		assert.equal(resolveSlot(undefined), null);
	});
});

describe("resolveConversationSpec (the turn gate's chain)", () => {
	it("chat.model over the strong slot; null when both empty", () => {
		assert.equal(resolveConversationSpec(undefined, null), null);
		assert.deepEqual(
			resolveConversationSpec(undefined, { provider: "zai", id: "s" }),
			{ provider: "zai", id: "s", thinkingLevel: undefined },
		);
		assert.deepEqual(
			resolveConversationSpec({ model: { provider: "groq", id: "c" } }, null),
			{ provider: "groq", id: "c", thinkingLevel: undefined },
		);
	});

	it("bare chat thinking level rides the strong slot's model", () => {
		assert.deepEqual(
			resolveConversationSpec({ thinkingLevel: "high" }, { provider: "zai", id: "s", thinkingLevel: "low" }),
			{ provider: "zai", id: "s", thinkingLevel: "high" },
		);
		// chat.model present, strong unset: level may still ride the chat alone
		assert.deepEqual(
			resolveConversationSpec({ model: { provider: "groq", id: "c" }, thinkingLevel: "max" }, null),
			{ provider: "groq", id: "c", thinkingLevel: "max" },
		);
		// nothing set anywhere: unset level, not a phantom one
		assert.deepEqual(resolveConversationSpec({ model: { provider: "groq", id: "c" } }, null), {
			provider: "groq",
			id: "c",
			thinkingLevel: undefined,
		});
	});
});
