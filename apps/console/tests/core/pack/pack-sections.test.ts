import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PACK_SECTIONS, packEntrySummary, packSectionFromSearch, parsePackSection, sectionBadges } from "../../../src/core/pack/pack-sections.ts";
import type { HealthLink, HealthSnapshotView } from "../../../src/core/pack/pack-health-view.ts";

const NOW = Date.parse("2026-11-12T10:00:00Z");
const link = (id: string, host: string, status: HealthLink["status"], over: Partial<HealthLink> = {}): HealthLink => ({
	id,
	kind: id === "hubd" ? "hubd" : id.startsWith("wolfd@") ? "wolfd" : "workerd",
	status,
	responseMs: 5,
	lagMs: 1,
	lastOkAt: null,
	lastCheckedAt: null,
	error: null,
	version: "0.1.15",
	uptimeS: 100,
	history: [{ status, at: "2026-11-12T08:00:00Z" }],
	lastRestart: null,
	restartable: true,
	host,
	...over,
});
const snap = (links: HealthLink[]): HealthSnapshotView => ({
	checkedAt: "2026-11-12T09:59:58Z",
	intervalMs: 5000,
	links,
	hosts: [
		{ id: "mac", label: "Mac", isThisConsole: true },
		{ id: "sfo-01", label: "sfo-01", isThisConsole: false },
	],
});
const summary = (snapshot: HealthSnapshotView | null, reachable = true) => packEntrySummary({ snapshot, reachable, now: NOW });

describe("the Settings entry's health wording", () => {
	it("says all good when every link is ok", () => {
		assert.deepEqual(summary(snap([link("hubd", "sfo-01", "ok"), link("workerd", "mac", "ok")])), { tone: "green", label: "All good" });
	});
	it("counts the machines that need attention", () => {
		const s = snap([link("hubd", "sfo-01", "degraded"), link("workerd", "mac", "ok"), link("wolfd@hal", "mac", "down"), link("wolfd@ada", "mac", "degraded")]);
		assert.equal(summary(s).label, "2 need attention");
	});
	it("says 1 needs attention when one machine has several links down", () => {
		const s = snap([link("hubd", "sfo-01", "ok"), link("workerd", "mac", "ok"), link("wolfd@hal", "mac", "down"), link("wolfd@ada", "mac", "degraded")]);
		assert.equal(summary(s).label, "1 needs attention");
	});
	it("agrees with the Machines badge on the count", () => {
		const s = snap([link("hubd", "sfo-01", "ok"), link("workerd", "mac", "degraded"), link("wolfd@hal", "mac", "down"), link("wolfd@ada", "mac", "down")]);
		assert.deepEqual(sectionBadges({ snapshot: s, reachable: true, now: NOW }).machines, { count: 1, tone: "red" });
		assert.equal(summary(s).label, "1 needs attention");
	});
	it("names a machine whose every link is down as offline", () => {
		const s = snap([link("hubd", "sfo-01", "down"), link("workerd", "sfo-01", "down"), link("wolfd@hal", "mac", "ok")]);
		assert.deepEqual(summary(s), { tone: "red", label: "sfo-01 offline" });
	});
	it("does not call a sleeping host offline when another host has a degraded link", () => {
		const s = snap([link("workerd", "mac", "down", { error: "host_asleep" }), link("hubd", "sfo-01", "degraded"), link("workerd", "sfo-01", "ok")]);
		assert.deepEqual(summary(s), { tone: "amber", label: "1 needs attention" });
	});
	it("names two machines that are both offline", () => {
		const s = snap([link("workerd", "mac", "down"), link("hubd", "sfo-01", "down"), link("workerd", "sfo-01", "down")]);
		assert.deepEqual(summary(s), { tone: "red", label: "Mac and sfo-01 offline" });
	});
	it("does not count a row the hub reported before it stopped answering", () => {
		const s = snap([link("hubd", "sfo-01", "down"), link("wolfd@hal", "sfo-01", "down", { error: "hub_stale" }), link("workerd", "mac", "ok")]);
		assert.equal(summary(s).label, "1 needs attention");
		assert.deepEqual(sectionBadges({ snapshot: s, reachable: true, now: NOW }).machines, { count: 1, tone: "red" });
	});
	it("does not count a sleeping host as a problem", () => {
		assert.equal(summary(snap([link("workerd", "mac", "down", { error: "host_asleep" })])).label, "All good");
	});
	it("says the console is unreachable when it does not answer", () => {
		assert.equal(summary(null, false).label, "Console unreachable");
	});
});

describe("the Pack section registry", () => {
	it("puts This device last in the menu", () => {
		assert.equal(PACK_SECTIONS.at(-1)!.label, "This device");
	});
	it("puts a problem count on the menu items that own the problem, and none elsewhere", () => {
		const s = snap([link("hubd", "sfo-01", "down"), link("workerd", "sfo-01", "down"), link("wolfd@hal", "mac", "down"), link("workerd", "mac", "ok")]);
		const b = sectionBadges({ snapshot: s, reachable: true, now: NOW });
		assert.deepEqual(b.machines, { count: 2, tone: "red" });
		assert.deepEqual(b.wolves, { count: 1, tone: "red" });
		assert.equal(b.keys, null);
		assert.equal(b.devices, null);
	});
	it("shows no badges without a snapshot", () => {
		assert.deepEqual(sectionBadges({ snapshot: null, reachable: true, now: NOW }), { machines: null, devices: null, wolves: null, domains: null, keys: null, "this-device": null });
	});
	it("reads ?pack= from the page URL: absent leaves the Pack closed, a name opens it", () => {
		assert.equal(packSectionFromSearch("?x=1"), null);
		assert.equal(packSectionFromSearch("?pack=keys"), "keys");
		assert.equal(packSectionFromSearch("?pack=nope"), "machines");
	});
	it("opens unknown section names on Machines", () => {
		assert.equal(parsePackSection("keys"), "keys");
		assert.equal(parsePackSection("nope"), "machines");
		assert.equal(parsePackSection(null), "machines");
	});
});
