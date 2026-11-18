/**
 * Seam: the Pack's section bodies, rendered to static markup (first paint). Protects work-wolfpack-u6GH2kk: the Settings dialog is gone,
 * so each of its seven former tabs must have a home in the Pack.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { KeysView } from "../../../components/pack/pack-keys.tsx";
import { DevicesBody } from "../../../components/pack/pack-devices.tsx";
import { ThisDeviceBody } from "../../../components/pack/pack-this-device.tsx";
import { WolfDetail } from "../../../components/pack/pack-wolves.tsx";
import { AppBridgeContext, type AppBridge } from "../../../components/settings/app-bridge.ts";

const noCall = (async () => new Response("{}")) as typeof fetch;
const machine = { hostId: "mac", machine: "Mac", online: true, canSetKeys: true, servesConsole: true, pubkey: "PK", slots: [], wolves: [{ name: "hal", transport: "subscription" as const }] };
const mac = { resetAppUi: async () => ({ ok: true }) } as unknown as AppBridge;

describe("every former Settings tab has a Pack home", () => {
	const wolf = renderToStaticMarkup(<WolfDetail machine={machine} wolf={machine.wolves[0]!} catalog={[]} reach={{ relay: false, machine: "Mac" }} call={noCall} onBack={() => {}} />);
	const device = renderToStaticMarkup(
		<AppBridgeContext.Provider value={mac}>
			<ThisDeviceBody />
		</AppBridgeContext.Provider>,
	);

	it("Keys: the Pack Keys grid", () => {
		const html = renderToStaticMarkup(<KeysView machines={[machine]} support={{ ok: true }} send={(async () => ({ id: "c", ok: true })) as never} reload={() => {}} />);
		assert.match(html, /data-testid="keys-group-chat"/);
	});

	it("Devices: the Pack Devices body", () => {
		assert.match(renderToStaticMarkup(<DevicesBody />), /data-testid="pack-devices"/);
	});

	it("Wolf settings: All settings inside a wolf's detail", () => {
		assert.match(wolf, /data-testid="wolf-all-settings"/);
	});

	it("Prompts: the wolf's prompt list", () => {
		assert.match(wolf, /data-testid="wolf-prompt-list"/);
	});

	it("Data and support: This device lists both folders, login, diagnostics and reset", () => {
		for (const id of ["this-device-folders", "this-device-wolves-button", "this-device-login", "this-device-support", "this-device-reset"]) assert.match(device, new RegExp(`data-testid="${id}"`), id);
		assert.match(device, /Your wolves/);
	});

	it("Appearance and Keyboard: This device", () => {
		assert.match(device, /data-testid="this-device-appearance"/);
		assert.match(device, /data-testid="this-device-keyboard"/);
	});
});
