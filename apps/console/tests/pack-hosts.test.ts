/** The health modal's per-host cards (work-wolfpack-w7RPvtd) at their seam: groupByHost over a snapshot. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { groupByHost, type HostCard } from "../src/core/pack-hosts.ts";
import type { HealthLink, HealthSnapshotView } from "../src/core/pack-health-view.ts";

const link = (id: string, host: string, over: Partial<HealthLink> = {}): HealthLink => ({
	id,
	kind: id === "hubd" ? "hubd" : id.startsWith("wolfd@") ? "wolfd" : id.startsWith("hub-link@") ? "hublink" : "workerd",
	status: "ok",
	responseMs: 9,
	lagMs: 2,
	lastOkAt: null,
	lastCheckedAt: null,
	error: null,
	version: null,
	uptimeS: null,
	history: [],
	lastRestart: null,
	restartable: true,
	host,
	...over,
});

/** What a card holds, by id: enough to read the layout at a glance. */
const shape = (cards: HostCard[]) =>
	cards.map((c) => ({
		id: c.id,
		label: c.label,
		checked: c.checked,
		console: c.console,
		facts: c.facts?.host ?? null,
		hub: c.hub?.id ?? null,
		workerds: c.workerds.map((w) => [w.link.id, w.wolves.map((x) => x.id)]),
		wolves: c.wolves.map((x) => x.id),
	}));

describe("pack health by host", () => {
	it("on sfo-01 puts the hub, both workerds with their wolves nested, the console and sfo-01's facts in one card, and keeps the Mac's facts as an unchecked card", () => {
		const snap: HealthSnapshotView = {
			checkedAt: null,
			intervalMs: 5000,
			hosts: [{ id: "sfo-01", label: "sfo-01", isThisConsole: true, platform: "linux" }],
			links: [link("hubd", "sfo-01"), link("workerd", "sfo-01"), link("workerd-wolves", "sfo-01"), link("wolfd@hal", "sfo-01", { via: "workerd-wolves" })],
		};
		assert.deepEqual(shape(groupByHost(snap)), [
			{ id: "sfo-01", label: "sfo-01", checked: true, console: true, facts: "sfo-01", hub: "hubd", workerds: [["workerd", []], ["workerd-wolves", ["wolfd@hal"]]], wolves: [] },
			{ id: "mac", label: "Mac", checked: false, console: false, facts: "Mac", hub: null, workerds: [], wolves: [] },
		]);
	});

	it("on the Mac orders this console's host first, then the hub's host, then the rest by label; a wolf without a workerd sits loose in its host", () => {
		const snap: HealthSnapshotView = {
			checkedAt: null,
			intervalMs: 5000,
			hosts: [
				{ id: "build-box", label: "build-box", isThisConsole: false },
				{ id: "sfo-01", label: "sfo-01", isThisConsole: false },
				{ id: "luka-air", label: "Mac", isThisConsole: true, platform: "darwin" },
			],
			links: [
				link("hubd", "sfo-01"),
				link("workerd-ci", "build-box"),
				link("workerd", "luka-air"),
				link("wolfd@hal", "luka-air", { via: "workerd" }),
				link("wolfd@ada", "build-box"),
			],
		};
		assert.deepEqual(shape(groupByHost(snap)), [
			{ id: "luka-air", label: "Mac", checked: true, console: true, facts: "Mac", hub: null, workerds: [["workerd", ["wolfd@hal"]]], wolves: [] },
			{ id: "sfo-01", label: "sfo-01", checked: true, console: false, facts: "sfo-01", hub: "hubd", workerds: [], wolves: [] },
			{ id: "build-box", label: "build-box", checked: true, console: false, facts: null, hub: null, workerds: [["workerd-ci", []]], wolves: ["wolfd@ada"] },
		]);
	});

	it("the hub's host without a map name (an older hubd seen by IP) is sfo-01's card, joined by the hub's sfo-01 entry; a look-alike name gets nothing of sfo-01", () => {
		const snap: HealthSnapshotView = {
			checkedAt: null,
			intervalMs: 5000,
			hosts: [
				{ id: "luka-air", label: "Mac", isThisConsole: true, platform: "darwin" },
				{ id: "100.120.154.69", label: "100.120.154.69", isThisConsole: false },
				{ id: "sfo-01", label: "sfo-01", isThisConsole: false, hubId: "sfo" },
				{ id: "sfo-010", label: "sfo-010", isThisConsole: false, hubId: "x" },
			],
			links: [
				link("hubd", "100.120.154.69"),
				link("workerd", "luka-air"),
				link("hub-link@sfo", "sfo-01", { source: "hub" }),
				link("wolfd@hal", "sfo-01", { via: "hub-link@sfo", source: "hub" }),
				link("hub-link@x", "sfo-010", { source: "hub" }),
			],
		};
		assert.deepEqual(shape(groupByHost(snap)), [
			{ id: "luka-air", label: "Mac", checked: true, console: true, facts: "Mac", hub: null, workerds: [["workerd", []]], wolves: [] },
			{ id: "sfo-01", label: "sfo-01", checked: true, console: false, facts: "sfo-01", hub: "hubd", workerds: [["hub-link@sfo", ["wolfd@hal"]]], wolves: [] },
			{ id: "sfo-010", label: "sfo-010", checked: true, console: false, facts: null, hub: null, workerds: [["hub-link@x", []]], wolves: [] },
		]);
	});
});
