import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });

const { useThreadSettings } = await import("../../../components/composer/composer-controls.tsx");
type Holder = ReturnType<typeof useThreadSettings>;

type Put = { method: string; body: string };
let puts: Put[] = [];
/** GETs of the settings url, in order: each waits for the test to release it with the value it should answer. */
let gets: Array<(v: object) => void> = [];
let holdGets = new Set<number>();
let getCount = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
	if (init?.method === "PUT") {
		puts.push({ method: "PUT", body: String(init.body) });
		return Response.json({ tier: "main", autoShip: JSON.parse(String(init.body)).autoShip });
	}
	const n = getCount++;
	if (holdGets.has(n)) return new Promise<Response>((res) => void (gets[n] = (v) => res(Response.json(v))));
	return Response.json({ tier: "main", autoShip: false });
}) as typeof fetch;

const roots: Root[] = [];
const flush = () => act(async () => void (await Promise.all([1, 2, 3, 4].map(() => new Promise((r) => setImmediate(r))))));
/** A real holder of one thread's settings, like the thread page's composer or the floating chat's gear. */
async function holder(): Promise<{ get: () => Holder }> {
	let latest: Holder | null = null;
	function Probe() {
		latest = useThreadSettings("1uk4", "home");
		return null;
	}
	const root = createRoot(document.body.appendChild(document.createElement("div")));
	roots.push(root);
	await act(async () => root.render(<Probe />));
	await flush();
	return { get: () => latest! };
}

afterEach(async () => {
	for (const r of roots.splice(0)) await act(async () => r.unmount());
	puts = [];
	gets = [];
	holdGets = new Set();
	getCount = 0;
});
after(() => void (globalThis.fetch = realFetch));

describe("one thread's settings held in two places (thread page and floating chat)", () => {
	it("a change in one holder reaches the other", async () => {
		const page = await holder();
		const gear = await holder();
		await act(async () => void (await page.get().change({ autoShip: true })));
		assert.equal(page.get().settings.autoShip, true);
		assert.equal(gear.get().settings.autoShip, true, "the gear follows the page");
		assert.deepEqual(puts.map((p) => p.body), ['{"autoShip":true}']);
	});

	it("a stale GET that returns after a change does not flip either holder back", async () => {
		const page = await holder();
		holdGets = new Set([getCount]); // the gear's GET is held while the page toggles
		const gear = await holder();
		await act(async () => void (await page.get().change({ autoShip: true })));
		assert.equal(gear.get().settings.autoShip, true);
		await act(async () => gets[1]!({ tier: "main", autoShip: false })); // the old value arrives late
		await flush();
		assert.equal(page.get().settings.autoShip, true, "the page keeps the new value");
		assert.equal(gear.get().settings.autoShip, true, "the gear keeps the new value");
		assert.equal(gear.get().loaded, true, "the late GET still marks the gear loaded");
		assert.deepEqual(puts.map((p) => p.body), ['{"autoShip":true}']);
	});
});
