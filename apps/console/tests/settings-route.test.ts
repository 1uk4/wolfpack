/** The Settings modal's URL <-> tab mapping: /prompts and /settings are the two routed tabs. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSettingsRoute, settingsTabHref } from "../components/settings/settings-route.ts";

describe("settings route", () => {
	it("/prompts opens the Prompts tab and keeps graph and node", () => {
		assert.deepEqual(parseSettingsRoute("/prompts", "graph=kb&node=pipeline.observer"), { section: "prompts", search: "?graph=kb&node=pipeline.observer" });
		assert.deepEqual(parseSettingsRoute("/prompts", ""), { section: "prompts", search: "" });
	});
	it("/settings opens the Wolf settings tab", () => {
		assert.deepEqual(parseSettingsRoute("/settings", ""), { section: "wolf", search: "" });
	});
	it("other paths are not settings routes", () => {
		assert.equal(parseSettingsRoute("/", ""), null);
		assert.equal(parseSettingsRoute("/chat/abc", "graph=kb"), null);
	});
	it("the routed tabs have hrefs and the others have none", () => {
		assert.equal(settingsTabHref("prompts"), "/prompts");
		assert.equal(settingsTabHref("wolf"), "/settings");
		assert.equal(settingsTabHref("keys"), null);
	});
});
