/**
 * Seam: ThisDeviceBody (components/pack/pack-this-device.tsx), rendered to static markup with the bridge provided through
 * AppBridgeContext: null is a plain browser, an object is the Mac app. Effects don't run in SSR, so this pins the first paint.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ThisDeviceBody } from "../../../components/pack/pack-this-device.tsx";
import { AppBridgeContext, type AppBridge } from "../../../components/settings/app-bridge.ts";

const render = (bridge: AppBridge | null) =>
	renderToStaticMarkup(
		<AppBridgeContext.Provider value={bridge}>
			<ThisDeviceBody />
		</AppBridgeContext.Provider>,
	);

describe("Pack > This device", () => {
	it("in a plain browser shows keyboard 'stored on this device' and hides every Mac-only control", () => {
		const html = render(null);
		assert.match(html, /data-testid="this-device-keyboard"/);
		assert.match(html, /Stored on this device/);
		for (const id of ["this-device-mac", "this-device-folders", "this-device-login", "this-device-support", "this-device-reset"]) {
			assert.ok(!html.includes(`data-testid="${id}"`), id);
		}
	});

	it("in the Mac app adds folders, open at login, diagnostics and a cache-only Reset app", () => {
		const html = render({ resetAppUi: async () => ({ ok: true }) } as unknown as AppBridge);
		assert.match(html, /data-testid="this-device-mac"/);
		for (const id of ["this-device-folders", "this-device-login", "this-device-support", "this-device-reset", "this-device-reset-button"]) {
			assert.match(html, new RegExp(`data-testid="${id}"`), id);
		}
		// The page says only what Reset really clears: caches. Sign-in, drafts and keyboard bindings stay.
		assert.match(html, /caches/);
		assert.match(html, /sign-in/);
		assert.match(html, /removed where they can be recognised/);
	});
});
