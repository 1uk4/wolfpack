/**
 * Seam: the console's own machine card (ConsoleMachineCard, components/pack/pack-machines.tsx) mounted with linkedom, its fetches
 * answered by a scripted stand-in for /api/health/update and /api/health/subscription (work-wolfpack-leOBfgn); and MachinesSection
 * mounted with the dev health fixture to check which card gets the Update button. Other cards are also rendered to static markup.
 * Covers the Update banner and button, progress, the result lines, the 10-minute bound, the 429 countdown, and the auto switch +
 * channel picker sharing one saved subscription.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConsoleMachineCard, MachineCard, MachinesSection } from "../../../components/pack/pack-machines.tsx";
import { machineCard } from "../../../src/core/pack/machine-card.ts";
import type { HealthLink } from "../../../src/core/pack/pack-health-view.ts";
import type { HostCard } from "../../../src/core/pack/pack-hosts.ts";

const link = (id: string, kind: HealthLink["kind"]): HealthLink => ({ id, kind, status: "ok", responseMs: 5, lagMs: 1, lastOkAt: null, lastCheckedAt: null, error: null, version: "0.1.14", uptimeS: 60, history: [], lastRestart: null, restartable: true });
const host = (over: Partial<HostCard> = {}): HostCard => ({ id: "sfo-01", label: "sfo-01", hubId: "sfo-01", checked: true, console: true, facts: null, hub: link("hubd", "hubd"), workerds: [], wolves: [], inventory: [], ...over });
const ACTIONS = { systemd: true, rollback: [] };
const UNITS = [{ component: "hubd", from: "0.1.14", to: "0.1.15" }];
const plain = (html: string) => html.replaceAll("&#x27;", "'");

type Call = { url: string; method: string; body: unknown };
/** The scripted server. Change its fields between steps to change what the next poll or POST sees. */
function script(init: { units?: typeof UNITS; last?: unknown; post?: number; retryAfter?: string; sub?: Record<string, unknown>; subStatus?: number; putStatus?: number; hold?: Promise<void>; updateDown?: boolean }) {
	const s = {
		units: init.units ?? UNITS,
		last: init.last ?? null,
		post: init.post ?? 202,
		retryAfter: init.retryAfter,
		sub: init.sub ?? { exists: true, channel: "stable", mode: "button" },
		subStatus: init.subStatus ?? 200,
		putStatus: init.putStatus ?? 200,
		hold: init.hold,
		updateDown: init.updateDown ?? false,
		calls: [] as Call[],
	};
	globalThis.fetch = (async (url: string, o?: RequestInit) => {
		const method = o?.method ?? "GET";
		s.calls.push({ url, method, body: o?.body ? JSON.parse(String(o.body)) : null });
		if (url.startsWith("/api/health/subscription")) {
			if (method === "PUT") {
				if (s.hold) await s.hold;
				if (s.putStatus !== 200) return new Response("{}", { status: s.putStatus });
				s.sub = { exists: true, ...JSON.parse(String(o!.body)) };
				return new Response("{}", { status: 200 });
			}
			return new Response(JSON.stringify(s.sub), { status: s.subStatus });
		}
		if (method === "POST") return new Response(s.post === 202 ? "{}" : JSON.stringify({ code: s.post === 409 ? "no_update" : "x" }), { status: s.post, headers: s.retryAfter ? { "Retry-After": s.retryAfter } : {} });
		if (s.updateDown) throw new Error("connection refused");
		return new Response(JSON.stringify({ units: s.units, last: s.last }), { status: 200 });
	}) as typeof fetch;
	return s;
}

const GLOBALS = ["window", "document", "Element", "HTMLElement", "HTMLInputElement", "IS_REACT_ACT_ENVIRONMENT", "fetch"] as const;
let saved: Record<string, unknown> = {};
beforeEach(() => void (saved = Object.fromEntries(GLOBALS.map((k) => [k, (globalThis as Record<string, unknown>)[k]]))));
afterEach(() => {
	mock.timers.reset();
	for (const k of GLOBALS) {
		if (saved[k] === undefined) delete (globalThis as Record<string, unknown>)[k];
		else (globalThis as Record<string, unknown>)[k] = saved[k];
	}
});

async function mount(node: React.ReactElement, search = "") {
	const { parseHTML } = await import("linkedom");
	const dom = parseHTML("<html><body></body></html>");
	Object.defineProperty(dom.window, "location", { value: { search }, configurable: true });
	Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, IS_REACT_ACT_ENVIRONMENT: true });
	const { createRoot } = await import("react-dom/client");
	const el = dom.document.createElement("div");
	dom.document.body.appendChild(el);
	const root = createRoot(el);
	await act(async () => root.render(node));
	await act(async () => {}); // the first polls
	const q = (id: string) => dom.document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
	const click = (id: string) => act(async () => void q(id)!.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true })));
	const change = (id: string, over: Record<string, unknown>) =>
		act(async () => {
			const input = q(id) as unknown as Record<string, unknown>;
			// linkedom cannot toggle or pick: call the control's React onChange with the event's target values.
			const key = Object.keys(input).find((k) => k.startsWith("__reactProps$"))!;
			(input[key] as { onChange: (e: unknown) => void }).onChange({ target: over, currentTarget: over });
		});
	return { dom, q, click, change, text: () => el.textContent ?? "", unmount: () => act(async () => root.unmount()) };
}

const own = (canAct = true) => <ConsoleMachineCard card={host()} canAct={canAct} actions={ACTIONS} logs={{}} />;
const posts = (s: ReturnType<typeof script>) => s.calls.filter((c) => c.method === "POST");
const puts = (s: ReturnType<typeof script>) => s.calls.filter((c) => c.method === "PUT");
const ask = async (m: Awaited<ReturnType<typeof mount>>) => {
	await m.click("machine-update-button");
	await m.click("machine-update-button-confirm");
};
const later = (at: number) => new Date(at).toISOString();

describe("Pack > Machines > Update (own machine)", () => {
	it("shows Update available with the target version and an Update button only on this console's own card", async () => {
		script({});
		const m = await mount(own());
		assert.match(m.q("machine-update")!.textContent ?? "", /Update available/);
		assert.match(m.q("machine-update")!.textContent ?? "", /hubd v0\.1\.14 → v0\.1\.15/);
		assert.ok(m.q("machine-update-button"));
		await m.unmount();
		const other = plain(renderToStaticMarkup(<MachineCard view={machineCard(host({ console: false }), null)} logs={{}} />));
		assert.ok(!other.includes("machine-update-button"));
		assert.match(other, /Update it from that machine's console/);
	});

	it("the Machines section puts the Update button on the console's own card and the 'update it from that machine' line on the remote one", async () => {
		script({});
		const m = await mount(<MachinesSection />, "?healthFixture=ok");
		for (let i = 0; i < 5 && m.dom.document.querySelectorAll('[data-testid="machine-card"]').length < 2; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
		const cards = [...m.dom.document.querySelectorAll('[data-testid="machine-card"]')] as HTMLElement[];
		assert.equal(cards.length, 2);
		const mine = cards.find((c) => c.getAttribute("data-machine") === "sfo-01")!;
		const remote = cards.find((c) => c !== mine)!;
		assert.ok(mine.querySelector('[data-testid="machine-update-button"]'));
		assert.equal(remote.querySelector('[data-testid="machine-update-button"]'), null);
		assert.match(remote.textContent ?? "", /Update it from that machine's console/);
		await m.unmount();
	});

	it("offers no Update when nothing is behind, and a disabled one when the console can't act", async () => {
		script({ units: [] });
		const none = await mount(own());
		assert.equal(none.q("machine-update-button"), null);
		await none.unmount();
		script({});
		const cant = await mount(own(false));
		assert.equal((cant.q("machine-update-button") as HTMLButtonElement).disabled, true);
		await cant.unmount();
	});

	it("Update asks first, then POSTs once, and shows Updating while the unit is still running", async () => {
		const s = script({});
		const m = await mount(own());
		await m.click("machine-update-button");
		assert.equal(posts(s).length, 0, "the first tap only asks");
		s.last = { result: "running", exitStatus: null, at: null };
		await m.click("machine-update-button-confirm");
		assert.equal(posts(s).length, 1);
		assert.equal(posts(s)[0]!.url, "/api/health/update");
		assert.match(m.q("machine-update-running")!.textContent ?? "", /Updating…/);
		await m.unmount();
	});

	it("shows Updating when the server already reports a run, with no second Update button, and 'reconnecting' once the poll fails", async () => {
		const s = script({ last: { result: "running", exitStatus: null, at: null } });
		const m = await mount(own());
		assert.match(m.q("machine-update-running")!.textContent ?? "", /Updating…/);
		assert.equal(m.q("machine-update-button"), null, "one update at a time");
		s.updateDown = true;
		await m.click("machine-check");
		assert.match(m.q("machine-update-running")!.textContent ?? "", /Updating; reconnecting…/);
		await m.unmount();
	});

	it("says Updated when the unit reports a newer successful run and nothing is behind", async () => {
		const s = script({});
		const m = await mount(own());
		s.units = [];
		s.last = { result: "success", exitStatus: 0, at: later(Date.now() + 1000) };
		await ask(m);
		assert.match(m.q("machine-update-done")!.textContent ?? "", /Updated/);
		await m.unmount();
	});

	it("reports a failed run with its reason and offers Update again", async () => {
		const s = script({});
		const m = await mount(own());
		s.last = { result: "exit-code", exitStatus: 4, at: later(Date.now() + 1000) };
		await ask(m);
		assert.match(m.q("machine-update-error")!.textContent ?? "", /Update failed \(another update run holds the lock\)/);
		assert.ok(m.q("machine-update-button"), "the button is back after the run finished");
		await m.unmount();
	});

	it("shows the result of a run that was started elsewhere once it finishes", async () => {
		const s = script({ last: { result: "running", exitStatus: null, at: null } });
		const m = await mount(own());
		s.last = { result: "exit-code", exitStatus: 1, at: later(Date.now() + 1000) };
		await m.click("machine-check");
		assert.match(m.q("machine-update-error")!.textContent ?? "", /Update failed \(exit 1\)/);
		assert.ok(m.q("machine-update-button"));
		assert.equal(m.q("machine-update-running"), null);
		await m.unmount();
	});

	it("gives up on a server-reported run still 'running' after 10 minutes and offers Update again", async () => {
		mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
		const s = script({ last: { result: "running", exitStatus: null, at: null } });
		const m = await mount(own());
		assert.ok(m.q("machine-update-running"));
		mock.timers.tick(9 * 60_000);
		await m.click("machine-check");
		assert.ok(m.q("machine-update-running"), "still within the bound");
		mock.timers.tick(2 * 60_000);
		await m.click("machine-check");
		assert.match(m.q("machine-update-error")!.textContent ?? "", /No result from the update after 10 min — see Logs/);
		assert.equal(m.q("machine-update-running"), null);
		assert.ok(m.q("machine-update-button"));
		assert.ok(s.calls.length > 0);
		await m.unmount();
	});

	it("says Already up to date on this machine for a 409 and drops the banner's Update available, and a 504 is an error that is never re-sent", async () => {
		const s = script({ post: 409 });
		const m = await mount(own());
		await ask(m);
		const banner = m.q("machine-update")!.textContent ?? "";
		assert.match(banner, /Already up to date on sfo-01/);
		assert.ok(!banner.includes("Update available"));
		s.units = UNITS;
		s.post = 504;
		await m.click("machine-check");
		await ask(m);
		assert.match(m.q("machine-update-error")!.textContent ?? "", /HTTP 504/);
		assert.equal(posts(s).length, 2, "one POST per tap, no automatic retry");
		await m.unmount();
	});

	it("counts the 429 wait down every second", async () => {
		mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
		script({ post: 429, retryAfter: "5" });
		const m = await mount(own());
		await ask(m);
		assert.match(m.q("machine-update-wait")!.textContent ?? "", /retry in 5s/);
		mock.timers.tick(2000);
		await act(async () => void (await new Promise((r) => setTimeout(r, 1100))));
		assert.match(m.q("machine-update-wait")!.textContent ?? "", /retry in 3s/);
		await m.unmount();
	});

	it("Check now re-reads the manifest with ?refresh=1 and feeds the same banner", async () => {
		const s = script({ units: [] });
		const m = await mount(own());
		assert.equal(m.q("machine-update"), null);
		s.units = UNITS;
		await m.click("machine-check");
		assert.ok(s.calls.some((c) => c.url === "/api/health/update?refresh=1"));
		assert.match(m.q("machine-update")!.textContent ?? "", /v0\.1\.15/);
		await m.unmount();
	});
});

describe("Pack > Machines > Update automatically (own machine)", () => {
	it("saves this machine's subscription with the picked mode and keeps the channel, and the channel picker keeps the mode", async () => {
		const s = script({});
		const m = await mount(own());
		assert.match(m.text(), /wolfd always waits for you/);
		await m.change("machine-auto-switch", { checked: true });
		assert.deepEqual(puts(s)[0]!.body, { channel: "stable", mode: "auto" });
		assert.equal((m.q("machine-auto-switch") as HTMLInputElement).checked, true);
		await m.change("machine-channel-select", { value: "main" });
		assert.deepEqual(puts(s)[1]!.body, { channel: "main", mode: "auto" });
		await m.change("machine-auto-switch", { checked: false });
		assert.deepEqual(puts(s)[2]!.body, { channel: "main", mode: "button" });
		assert.equal((m.q("machine-auto-switch") as HTMLInputElement).checked, false);
		await m.unmount();
	});

	it("a failed save reverts the switch and says Could not save", async () => {
		const s = script({ putStatus: 500 });
		const m = await mount(own());
		await m.change("machine-auto-switch", { checked: true });
		assert.equal(puts(s).length, 1);
		assert.equal((m.q("machine-auto-switch") as HTMLInputElement).checked, false);
		assert.match(m.q("machine-save-error")!.textContent ?? "", /Could not save/);
		await m.unmount();
	});

	it("disables the switch and the channel picker while a save is in flight", async () => {
		let release!: () => void;
		const s = script({ hold: new Promise<void>((r) => (release = r)) });
		const m = await mount(own());
		await m.change("machine-auto-switch", { checked: true });
		assert.equal((m.q("machine-auto-switch") as HTMLInputElement).disabled, true);
		assert.equal((m.q("machine-channel-select") as HTMLSelectElement).disabled, true);
		await act(async () => release());
		assert.equal((m.q("machine-auto-switch") as HTMLInputElement).disabled, false);
		assert.equal((m.q("machine-channel-select") as HTMLSelectElement).disabled, false);
		assert.equal(puts(s).length, 1);
		await m.unmount();
	});

	it("keeps the switch disabled and says so when the machine's settings can't be read, and never saves a guessed channel", async () => {
		const s = script({ subStatus: 500 });
		const m = await mount(own());
		assert.match(m.q("machine-sub-error")!.textContent ?? "", /Could not read this machine's update settings/);
		assert.equal((m.q("machine-auto-switch") as HTMLInputElement).disabled, true);
		assert.equal(m.q("machine-channel-select"), null);
		await m.change("machine-auto-switch", { checked: true });
		assert.equal(puts(s).length, 0);
		await m.unmount();
	});

	it("says the setting is not set when there is no subscription file", async () => {
		script({ sub: { exists: false, channel: "stable", mode: "unknown" } });
		const m = await mount(own());
		assert.match(m.text(), /not set \(host default\)/);
		assert.equal((m.q("machine-auto-switch") as HTMLInputElement).checked, false);
		await m.unmount();
	});
});
