/**
 * Settings-surface render tests (thin settings wave): SSR of the section
 * components pins the THIN markup — toggle rows, the mode control's
 * honest disabled state, the slot rows. Fetches don't run under renderToStaticMarkup (effects never
 * fire), so the SSR state IS the loading state — asserted as such.
 * Same tsx classic-JSX shim as render-sidebar.test.tsx.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppearanceSection } from "../../../components/settings/appearance-section.tsx";
import { KeysSection } from "../../../components/settings/keys-section.tsx";
import { KeyboardSection } from "../../../components/settings/keyboard-section.tsx";
import { SettingsDialogBody, SettingsDialogProvider } from "../../../components/settings/settings-dialog.tsx";
import { AppBridgeContext, type AppBridge } from "../../../components/settings/app-bridge.ts";
import { SingleMacContext } from "../../../components/shell/single-mac.tsx";
import { KEYBOARD_ACTIONS } from "../../../src/core/index.ts";

/** The full opening tag of the element carrying a testid — attribute
 *  order in React output is not contractual, so assertions run on the
 *  whole tag instead of ordered regex chains. */
function tagOf(html: string, testid: string): string {
	const i = html.indexOf(`data-testid="${testid}"`);
	assert.ok(i >= 0, `missing ${testid}`);
	return html.slice(html.lastIndexOf("<", i), html.indexOf(">", i) + 1);
}

describe("SettingsDialog hidden tabs", () => {
	it("a deep link to a hidden or removed tab lands on Keys", () => {
		for (const section of ["keyboard", "agent"]) {
			const html = renderToStaticMarkup(<SettingsDialogBody onClose={() => {}} initialSection={section as never} />);
			assert.ok(tagOf(html, "settings-nav-keys").includes('aria-current="true"'), section);
		}
	});
});

describe("SettingsDialog in the single-Mac app", () => {
	it("has no Keys or Devices tab and lands on the first visible tab (the setup wizard owns the API key)", () => {
		const html = renderToStaticMarkup(
			<SingleMacContext.Provider value={true}>
				<SettingsDialogBody onClose={() => {}} />
			</SingleMacContext.Provider>,
		);
		for (const id of ["keys", "devices"]) assert.ok(!html.includes(`data-testid="settings-nav-${id}"`), id);
		assert.ok(tagOf(html, "settings-nav-wolf").includes('aria-current="true"'));
	});
});

describe("SettingsDialog Data and support tab", () => {
	const bridge = {} as AppBridge;
	const render = (singleMac: boolean, b: AppBridge | null) =>
		renderToStaticMarkup(
			<SingleMacContext.Provider value={singleMac}>
				<AppBridgeContext.Provider value={b}>
					<SettingsDialogBody onClose={() => {}} />
				</AppBridgeContext.Provider>
			</SingleMacContext.Provider>,
		);
	it("shows only in the single-Mac app with the desktop bridge", () => {
		assert.ok(render(true, bridge).includes('data-testid="settings-nav-data"'));
		assert.ok(!render(false, bridge).includes('data-testid="settings-nav-data"'));
		assert.ok(!render(true, null).includes('data-testid="settings-nav-data"'));
	});
});

describe("SettingsDialog (the designed surface, SSR)", () => {
	it("provider CLOSED: children only — no dialog, no portal content", () => {
		const html = renderToStaticMarkup(
			<SettingsDialogProvider>
				<p>the app</p>
			</SettingsDialogProvider>,
		);
		assert.ok(html.includes("the app"));
		assert.ok(!html.includes("settings-backdrop"));
		assert.ok(!html.includes("settings-dialog"));
	});

	it("the dialog frame: role=dialog + the ✕ + the four-section nav, Keys active", () => {
		const html = renderToStaticMarkup(<SettingsDialogBody onClose={() => {}} />);
		assert.ok(html.includes('role="dialog"'));
		assert.ok(html.includes('aria-modal="true"'));
		assert.ok(html.includes('aria-label="Close settings"'));
		for (const id of ["keys", "devices"]) {
			assert.ok(html.includes(`data-testid="settings-nav-${id}"`), id);
		}
		// Agent is gone; Keyboard and Appearance are hidden for now (flag in SECTIONS).
		for (const id of ["agent", "appearance", "keyboard"]) {
			assert.ok(!html.includes(`data-testid="settings-nav-${id}"`), id);
		}
		// Keys is the landing section; the others are not current.
		assert.ok(tagOf(html, "settings-nav-keys").includes('aria-current="true"'));
		assert.ok(tagOf(html, "settings-nav-devices").includes('aria-current="false"'));
		// Fetches don't run under SSR — the loading state IS the SSR state.
		assert.ok(html.includes("Loading settings…"));
		// Modal-only doctrine: no link back to /settings anywhere in it.
		assert.ok(!html.includes('href="/settings"'));
		// Removed (wolf Settings page owns models): no General/Auto-update section.
		assert.ok(!html.includes("settings-nav-general") && !html.includes("Auto-update"));
	});
});

describe("KeysSection (thin SSR)", () => {
	it("SSR = the loading state (effects never fire)", () => {
		const html = renderToStaticMarkup(<KeysSection />);
		assert.ok(html.includes("Loading keys…"));
	});
});

describe("AppearanceSection (thin SSR)", () => {
	it("mode is rendered DISABLED — dark-only this wave, no lying control", () => {
		const html = renderToStaticMarkup(<AppearanceSection appearance={undefined} onSectionChange={() => {}} />);
		assert.ok(tagOf(html, "select-mode").includes("disabled"), "mode select disabled");
		assert.ok(html.includes("Coming soon"));
		// The whole row dims, graph-view style (the control never adds its own).
		assert.ok(tagOf(html, "row-mode").includes("opacity-40"), "mode row dims whole");
	});

	it("hex inputs carry the factory placeholders; prose size resolves against the factory", () => {
		const html = renderToStaticMarkup(<AppearanceSection appearance={undefined} onSectionChange={() => {}} />);
		assert.ok(html.includes(`placeholder="#0f141a"`));
		// The reading font is the searchable dropdown now (font-menu
		// wave): its trigger shows the factory family; the emphasis
		// inks' empty state is "same as text" (the old hexes died with
		// the factory token change).
		assert.ok(html.includes('data-testid="font-trigger"'));
		assert.equal((html.match(/Empty = same as text/g) ?? []).length, 2);
		assert.ok(html.includes("16px"));
	});

	it("a set background shows in the input, not the placeholder", () => {
		const html = renderToStaticMarkup(
			<AppearanceSection appearance={{ background: "#1a1a2e" }} onSectionChange={() => {}} />,
		);
		assert.ok(html.includes(`value="#1a1a2e"`));
	});
});

describe("KeyboardSection (thin SSR)", () => {
	it("renders every registry action in its scope group", () => {
		const html = renderToStaticMarkup(<KeyboardSection />);
		for (const def of KEYBOARD_ACTIONS) {
			assert.ok(html.includes(`data-testid="kbd-row-${def.id}"`), def.id);
		}
		assert.ok(html.includes("kbd-scope-global"));
		assert.ok(html.includes("kbd-scope-chat"));
	});

	it("open-settings is in the registry with the settings chord", () => {
		const def = KEYBOARD_ACTIONS.find((a) => a.id === "open-settings");
		assert.ok(def, "the action exists");
		assert.equal(def?.scope, "global");
		assert.equal(def?.binding, "mod+,");
	});

	it("displayOnly actions list but never offer Rebind", () => {
		const html = renderToStaticMarkup(<KeyboardSection />);
		assert.ok(html.includes("Fixed — part of this screen"));
		assert.ok(!html.includes(`data-testid="kbd-rebind-question-next-row"`), "surface keys stay put");
		// The model-menu entries are GONE entirely (owner, 2026-10-10):
		// obvious in-field navigation, not settings material.
		assert.ok(!html.includes("Model menu"), "model-menu rows removed");
		assert.ok(!KEYBOARD_ACTIONS.some((a) => a.id as string === "model-menu-walk"));
		assert.ok(!KEYBOARD_ACTIONS.some((a) => a.id as string === "model-menu-pick"));
	});
});