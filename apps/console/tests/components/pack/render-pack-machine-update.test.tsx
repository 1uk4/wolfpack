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
import { SingleMacContext } from "../../../components/shell/single-mac.tsx";
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
function script(init: { units?: typeof UNITS; last?: unknown; post?: number; retryAfter?: string; sub?: Record<string, unknown>; subStatus?: number; putStatus?: number; hold?: Promise<void>; updateDown?: boolean; updateState?: unknown; inventory?: unknown[]; cmd?: unknown; cmdHold?: Promise<void> }) {
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
		updateState: init.updateState as unknown,
		inventory: init.inventory,
		cmd: init.cmd ?? { id: "c-1", ok: true },
		cmdHold: init.cmdHold,
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
		if (url.startsWith("/api/machines/")) {
			if (s.cmdHold) await s.cmdHold;
			return new Response(JSON.stringify(s.cmd), { status: 200 });
		}
		if (url.startsWith("/api/health/inventory") && s.inventory) return new Response(JSON.stringify({ state: "ok", rows: s.inventory, hubMachine: "sfo-01" }), { status: 200 });
		if (method === "POST") return new Response(s.post === 202 ? "{}" : JSON.stringify({ code: s.post === 409 ? "no_update" : "x" }), { status: s.post, headers: s.retryAfter ? { "Retry-After": s.retryAfter } : {} });
		if (s.updateDown) throw new Error("connection refused");
		return new Response(JSON.stringify({ units: s.units, last: s.last, ...(s.updateState ? { updateState: s.updateState } : {}) }), { status: 200 });
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
	Object.defineProperty(dom.window, "location", { value: { search, pathname: "/pack/machines", hash: "" }, configurable: true });
	const replaced: string[] = [];
	Object.defineProperty(dom.window, "history", { value: { state: null, replaceState: (_s: unknown, _t: string, url: string) => void replaced.push(url) }, configurable: true });
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
	return { dom, replaced, q, click, change, text: () => el.textContent ?? "", unmount: () => act(async () => root.unmount()) };
}

const own = (canAct = true) => <ConsoleMachineCard card={host()} canAct={canAct} actions={ACTIONS} logs={{}} />;
const posts = (s: ReturnType<typeof script>) => s.calls.filter((c) => c.method === "POST");
const puts = (s: ReturnType<typeof script>) => s.calls.filter((c) => c.method === "PUT");
const ask = async (m: Awaited<ReturnType<typeof mount>>) => {
	await m.click("machine-update-button");
	await m.click("machine-update-button-confirm");
};
const later = (at: number) => new Date(at).toISOString();

const hostState = (state: string, extra: Record<string, unknown> = {}) => ({ target: "pack", host: "sfo-01", component: "hubd", state, current: "0.1.14", latest: "0.1.15", progress: null, lastCheck: null, channel: "stable", auto: "on", ...extra });

describe("Pack > Machines > host update stage (work-wolfpack-WIaZh5k)", () => {
	it("shows Installing… while the host installs, and Update failed with the plain reason when it failed", async () => {
		script({ updateState: hostState("installing") });
		const a = await mount(own());
		assert.match(a.q("machine-host-stage")!.textContent ?? "", /Installing…/);
		await a.unmount();
		script({ updateState: hostState("failed", { error: { code: "unhealthy", message: "The update installed but the service did not start healthy, so it was left as it is.", retryable: false } }) });
		const b = await mount(own());
		assert.match(b.q("machine-host-stage")!.textContent ?? "", /Update failed.*did not start healthy/);
		await b.unmount();
	});
});

const FAILED = hostState("failed", { error: { code: "unhealthy", message: "The update installed but the service did not start healthy, so it was left as it is.", retryable: false } });

describe("Pack > Machines > Retry a failed update (work-wolfpack-s0Tnbth)", () => {
	it("a failed update on this machine shows the plain reason and Retry, never a command; Retry sends one POST with clearFailed and is gone while the run is pending", async () => {
		const s = script({ updateState: FAILED });
		const m = await mount(own());
		assert.match(m.q("machine-host-stage")!.textContent ?? "", /^Update failed.*did not start healthy/);
		assert.doesNotMatch(m.text(), /--clear-failed|ssh|RUNBOOK|runtime:update|pnpm/i);
		assert.equal(m.q("machine-update-retry")!.textContent, "Retry");
		s.last = { result: "running", exitStatus: null, at: null };
		await m.click("machine-update-retry");
		assert.deepEqual(posts(s).map((c) => c.body), [{ service: "update", clearFailed: true }]);
		assert.equal(m.q("machine-update-retry"), null, "no second send while pending");
		await m.unmount();
	});

	it("a failed update on a machine whose worker cannot run update.run shows the reason and the plain 'from its own console' line, with no button", () => {
		const row = { machine: "sfo-01", kind: "workerd" as const, id: "workerd", ageS: 3, latest: null, updateState: FAILED as never };
		const view = machineCard(host({ console: false, commands: ["logs.fetch"], inventory: [row] }), null);
		const out = plain(renderToStaticMarkup(<MachineCard view={view} logs={{}} />));
		assert.match(out, /Update failed: The update installed but the service did not start healthy/);
		assert.match(out, /Update it from that machine's console/);
		assert.doesNotMatch(out, /Open sfo-01's console/);
		assert.ok(!out.includes("machine-update-retry") && !out.includes("machine-remote-update"));
	});
});

describe("Pack > Machines > Update a remote machine (work-wolfpack-NqEVJAU)", () => {
	const workerdRow = (over: Record<string, unknown> = {}) => ({ machine: "sfo-01", kind: "workerd", id: "sfo-01-wolves", version: "0.1.9", channel: "stable", ageS: 3, latest: null, ...over });
	const cmds = (s: ReturnType<typeof script>) => s.calls.filter((c) => c.url.startsWith("/api/machines/"));
	const remote = async (s: ReturnType<typeof script>) => {
		const m = await mount(<MachinesSection />, "?healthFixture=two-hosts-mac-view");
		for (let i = 0; i < 8 && !m.q("machine-remote-update"); i++) await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
		void s;
		return m;
	};

	it("Retry on a failed remote card sends update.run with clearFailed once, is disabled while pending, and says the update started", async () => {
		let release = () => {};
		const s = script({ inventory: [workerdRow({ updateState: FAILED })], cmdHold: new Promise<void>((r) => (release = r)) });
		const m = await remote(s);
		assert.match(m.q("machine-remote-failed")!.textContent ?? "", /Update failed: The update installed but the service did not start healthy/);
		assert.equal(m.q("machine-remote-update-button"), null, "nothing is behind: no Update, only Retry");
		await m.click("machine-remote-retry");
		await m.click("machine-remote-retry");
		assert.deepEqual(cmds(s).map((c) => [c.url, c.body]), [["/api/machines/sfo-01/commands", { kind: "update.run", args: { clearFailed: true } }]], "one send, however many taps");
		assert.equal((m.q("machine-remote-retry") as HTMLButtonElement).disabled, true);
		release();
		await act(async () => {});
		assert.match(m.q("machine-remote-note")!.textContent ?? "", /Update started/);
		await m.unmount();
	});

	it("Update on a remote card that is behind sends update.run, and a timeout reads 'Update sent; it may take a few minutes.' without a resend", async () => {
		const s = script({ inventory: [workerdRow({ latest: "0.1.10" })], cmd: { id: "c-1", ok: false, code: "timeout" } });
		const m = await remote(s);
		assert.equal(m.q("machine-remote-available")!.textContent, "workerd 0.1.10 is available");
		await m.click("machine-remote-update-button");
		assert.deepEqual(cmds(s).map((c) => c.body), [{ kind: "update.run", args: {} }]);
		assert.equal(m.q("machine-remote-note")!.textContent, "Update sent; it may take a few minutes.");
		await m.unmount();
	});

	it("shows a remote machine's installing state as running, with no button to press", async () => {
		const s = script({ inventory: [workerdRow({ latest: "0.1.10", updateState: hostState("installing") })] });
		const m = await remote(s);
		assert.match(m.q("machine-remote-stage")!.textContent ?? "", /Installing…/);
		assert.equal(m.q("machine-remote-update-button"), null);
		const remoteCard = [...m.dom.document.querySelectorAll('[data-testid="machine-card"]')].find((c) => c.querySelector('[data-testid="machine-remote-update"]'))!;
		assert.match(remoteCard.querySelector('[data-testid="update-details"]')?.textContent ?? "", /Roll back from that machine's console\./);
		assert.equal(remoteCard.querySelector('[data-testid="update-rollback"]'), null);
		assert.equal(cmds(s).length, 0);
		await m.unmount();
	});
});

describe("Pack > Machines > Update details (work-wolfpack-B8vtRi3)", () => {
	it("this console's card lists the update details and offers Roll back to the kept release, which posts to /api/health/rollback", async () => {
		const s = script({ updateState: hostState("idle", { lastCheck: new Date().toISOString() }) });
		const actions = { systemd: true, rollback: [{ service: "hubd", from: "0.1.15", to: "0.1.14" }, { service: "console", from: "0.1.20", to: "0.1.19" }] };
		const m = await mount(<ConsoleMachineCard card={host()} canAct actions={actions} logs={{}} />);
		const area = m.q("machine-update-area")!.parentElement!;
		assert.equal(m.q("machine-channel")!.compareDocumentPosition(m.q("update-details")!) & 4, 4, "Update details sits below the channel / Check now row");
		assert.ok(area.contains(m.q("update-details")!));
		const t = m.q("update-details")!.textContent ?? "";
		assert.match(t, /Channel:\s*stable/);
		assert.match(t, /0\.1\.14 → 0\.1\.15/);
		assert.match(t, /Auto-update:\s*on/);
		(window as unknown as { confirm: () => boolean }).confirm = () => true;
		assert.equal(m.q("update-rollback-hubd")?.textContent, "Roll back hubd to 0.1.14");
		assert.equal(m.q("update-rollback-console")?.textContent, "Roll back console to 0.1.19");
		await m.click("update-rollback-console");
		assert.deepEqual(posts(s).filter((c) => c.url.includes("rollback")).map((c) => c.body), [{ service: "console" }]);
		await m.unmount();
	});
});

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
		assert.match(m.q("machine-update-error")!.textContent ?? "", /Update failed: Another update is already running\./);
		assert.ok(m.q("machine-update-button"), "the button is back after the run finished");
		await m.unmount();
	});

	it("shows the result of a run that was started elsewhere once it finishes", async () => {
		const s = script({ last: { result: "running", exitStatus: null, at: null } });
		const m = await mount(own());
		s.last = { result: "exit-code", exitStatus: 1, at: later(Date.now() + 1000) };
		await m.click("machine-check");
		assert.match(m.q("machine-update-error")!.textContent ?? "", /Update failed: The update did not finish\./);
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
		assert.match(m.q("machine-update-error")!.textContent ?? "", /Update failed: No result after 10 minutes\./);
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
		assert.match(m.q("machine-update-error")!.textContent ?? "", /Update failed: The console answered with an error\./);
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
		assert.match(m.q("machine-channel")!.textContent ?? "", /Couldn't read this machine's update settings/);
		assert.doesNotMatch(m.q("machine-channel")!.textContent ?? "", /Change it from that machine's console/);
		assert.equal(m.q("machine-mode")!.textContent, "· manual");
		assert.equal((m.q("machine-auto-switch") as HTMLInputElement).disabled, true);
		assert.equal((m.q("machine-channel-select") as HTMLSelectElement).disabled, true);
		await m.change("machine-auto-switch", { checked: true });
		assert.equal(puts(s).length, 0);
		await m.unmount();
	});

	it("in the Mac app shows the app's own update block and no channel row, picker, switch, pack Check now or PUT", async () => {
		const s = script({ sub: { exists: false, channel: "stable", mode: "button" } });
		const m = await mount(<SingleMacContext.Provider value={true}>{own()}</SingleMacContext.Provider>);
		assert.notEqual(m.q("machine-app-update"), null);
		for (const id of ["machine-channel", "machine-channel-value", "machine-channel-select", "machine-auto-switch", "machine-check"]) assert.equal(m.q(id), null, id);
		assert.equal(puts(s).length, 0);
		await m.unmount();
	});

	it("this console's card names wolves behind on it, from the hub inventory rows, and offers no Update for them", async () => {
		script({ units: [] });
		const row = (kind: string, id: string, version: string, latest: string | null) => ({ machine: "sfo-01", kind, id, version, latest, ageS: 1 });
		const m = await mount(<ConsoleMachineCard card={host({ inventory: [row("wolfd", "1uk4", "0.1.24-main.3", "0.1.24-main.4"), row("wolfd", "hal", "0.1.24-main.3", "0.1.24-main.4"), row("workerd", "w", "0.1.10", null)] as never })} canAct actions={ACTIONS} logs={{}} />);
		assert.match(m.q("machine-wolves-behind")!.textContent ?? "", /wolfd v0\.1\.24-main\.3 → v0\.1\.24-main\.4/);
		assert.equal((m.q("machine-wolves-behind")!.textContent ?? "").match(/wolfd/g)?.length, 1);
		assert.equal(m.q("machine-update-button"), null);
		await m.unmount();
	});

	it("starts the update once when opened from the sidebar notice (?update=<this machine>:<component>) and clears the param", async () => {
		const s = script({});
		const m = await mount(own(), "?update=sfo-01%3Ahubd");
		assert.equal(posts(s).length, 1);
		assert.deepEqual(posts(s)[0]!.body, { service: "update" });
		assert.deepEqual(m.replaced, ["/pack/machines"]);
		assert.ok(m.q("machine-update-running"));
		await m.unmount();
	});

	it("does not start an update when the notice names another machine or nothing is behind", async () => {
		const other = script({});
		const a = await mount(own(), "?update=hal2%3Ahubd");
		assert.equal(posts(other).length, 0);
		await a.unmount();
		const none = script({ units: [] });
		const b = await mount(own(), "?update=sfo-01%3Ahubd");
		assert.equal(posts(none).length, 0);
		assert.deepEqual(b.replaced, ["/pack/machines"]);
		await b.unmount();
	});

	it("says the setting is not set when there is no subscription file", async () => {
		script({ sub: { exists: false, channel: "stable", mode: "unknown" } });
		const m = await mount(own());
		assert.match(m.text(), /not set \(host default\)/);
		assert.equal((m.q("machine-auto-switch") as HTMLInputElement).checked, false);
		await m.unmount();
	});
});
