import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });

const { useAppUpdateState } = await import("../../../components/settings/use-app-update-state.ts");
const { AppBridgeContext } = await import("../../../components/settings/app-bridge.ts");
type Ev = Record<string, unknown>;

// work-wolfpack-5IZ3Xc9: the hook turns the Mac app's raw updater steps into the shared UpdateState.
let seen: { state: string; progress: number | null; latest: string | null; error?: { message: string } } | null | undefined;
function Probe() {
	seen = useAppUpdateState();
	return null;
}

let root: Root | null = null;
let push: (e: Ev) => void = () => {};
async function mount(bridge: unknown) {
	root = createRoot(document.createElement("div"));
	await act(async () => {
		root!.render(
			<AppBridgeContext.Provider value={bridge as never}>
				<Probe />
			</AppBridgeContext.Provider>,
		);
	});
}
const fakeBridge = (initial: Ev | null) => ({
	getUpdateState: async () => initial,
	onUpdateStatus: (cb: (e: Ev) => void) => {
		push = cb;
		return () => {};
	},
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	seen = undefined;
});

describe("useAppUpdateState", () => {
	it("is null outside the desktop app", async () => {
		await mount(null);
		assert.equal(seen, null);
	});

	it("follows the updater steps: available, download percent, ready", async () => {
		await mount(fakeBridge(null));
		await act(async () => push({ type: "available", version: "1.2.0" }));
		assert.equal(seen?.state, "available");
		await act(async () => push({ type: "progress", percent: 40 }));
		assert.deepEqual([seen?.state, seen?.progress], ["downloading", 40]);
		await act(async () => push({ type: "downloaded", version: "1.2.0", status: "downloaded" }));
		assert.deepEqual([seen?.state, seen?.latest], ["ready", "1.2.0"]);
	});

	it("starts from the step a window missed while it was closed", async () => {
		await mount(fakeBridge({ type: "progress", percent: 73 }));
		assert.deepEqual([seen?.state, seen?.progress], ["downloading", 73]);
	});

	it("shows a failed background check as a failed state with a plain message", async () => {
		await mount(fakeBridge(null));
		await act(async () => push({ type: "error", message: "net::ERR_INTERNET_DISCONNECTED" }));
		assert.equal(seen?.state, "failed");
		assert.match(seen?.error?.message ?? "", /internet connection/);
	});
});
