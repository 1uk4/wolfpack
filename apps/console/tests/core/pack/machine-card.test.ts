/** Seam: machineCard / restartPlan / restartSummary / logLines (src/core/pack/machine-card.ts): which rows, actions and wording a Machines card shows. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { logLines, machineCard, restartSummary } from "../../../src/core/pack/machine-card.ts";
import type { HealthLink } from "../../../src/core/pack/pack-health-view.ts";
import type { HostCard } from "../../../src/core/pack/pack-hosts.ts";

const link = (id: string, kind: HealthLink["kind"], over: Partial<HealthLink> = {}): HealthLink => ({
	id, kind, status: "ok", responseMs: 5, lagMs: 1, lastOkAt: null, lastCheckedAt: null, error: null, version: "0.1.20", uptimeS: 60, history: [], lastRestart: null, restartable: true, ...over,
});
const card = (over: Partial<HostCard> = {}): HostCard => ({ id: "sfo-01", label: "sfo-01", hubId: "sfo-01", checked: true, console: false, facts: null, hub: null, workerds: [], wolves: [], inventory: [], ...over });

describe("machineCard", () => {
	it("names the four services and flags the one that is down with its log service", () => {
		const c = card({ commands: ["logs.fetch"], hub: link("hubd", "hubd"), workerds: [{ link: link("workerd", "workerd", { status: "down", error: "refused" }), wolves: [link("wolfd@ada", "wolfd")] }] });
		const v = machineCard(c, null);
		assert.equal(v.online, true);
		assert.deepEqual(v.services.map((s) => [s.label, s.down, s.logService]), [["Hub", false, undefined], ["Wolf runtime", false, undefined], ["Background service", true, "workerd"]]);
	});
	it("is offline when every link is down or its host asleep, and nothing is offered then", () => {
		const v = machineCard(card({ workerds: [{ link: link("workerd", "workerd", { status: "down", error: "host_offline" }), wolves: [] }] }), null);
		assert.equal(v.online, false);
		assert.deepEqual(v.services.map((s) => s.restart), [undefined]);
	});
	it("shows another machine's channel read-only, and the console's own as editable", () => {
		const inv = [{ machine: "sfo-01", kind: "workerd" as const, id: "workerd", version: "0.1.20", channel: "main" as const, ageS: 3, latest: null }];
		assert.deepEqual(machineCard(card({ inventory: inv, workerds: [{ link: link("workerd", "workerd"), wolves: [] }] }), null).channel, { value: "main", editable: false, note: "Change it from that machine's console" });
		assert.equal(machineCard(card({ console: true, workerds: [{ link: link("workerd", "workerd"), wolves: [] }] }), "stable").channel.editable, true);
	});
});

describe("machineCard wolves", () => {
	it("lists each wolf by name under the Wolf runtime summary, sorted, with its own status and version", () => {
		const inv = (id: string, version: string) => ({ machine: "sfo-01", kind: "wolfd" as const, id, parent: "workerd", version, ageS: 3, latest: null });
		const c = card({
			commands: ["logs.fetch"],
			inventory: [inv("hal", "0.1.21"), inv("1uk4", "0.1.20")],
			workerds: [{ link: link("workerd", "workerd"), wolves: [link("wolfd@hal", "wolfd", { version: "0.1.21" }), link("wolfd@1uk4", "wolfd", { status: "down", error: "refused", version: "0.1.20" })] }],
		});
		const s = machineCard(c, null).services.find((x) => x.kind === "wolfd")!;
		assert.equal(s.count, 2);
		assert.equal(s.down, true);
		assert.equal(s.logService, "1uk4");
		assert.deepEqual(s.wolves, [
			{ name: "1uk4", status: "down", tone: "red", version: "0.1.20" },
			{ name: "hal", status: "ok", tone: "green", version: "0.1.21" },
		]);
	});
});

describe("machineCard inventory states", () => {
	const wolfRow = (id: string, version?: string) => ({ machine: "sfo-01", kind: "wolfd" as const, id, parent: "workerd", ...(version ? { version } : {}), ageS: 3, latest: null });
	const bare = (inventoryState?: HostCard["inventoryState"], inventory = [wolfRow("a"), wolfRow("b", "0.1.21")]) =>
		card({ inventory, ...(inventoryState ? { inventoryState } : {}), workerds: [{ link: link("workerd", "workerd", { version: null }), wolves: [] }] });
	it("shows the first reported version of a kind, not just the first row's", () => {
		const v = machineCard(bare("ok"), null);
		assert.equal(v.services.find((s) => s.kind === "wolfd")!.version, "0.1.21");
	});
	it("says why a version is missing when the inventory could not be read, and keeps 'version unknown' for rows that were read", () => {
		const none = bare("ok", []);
		assert.equal(machineCard(none, null).services[0]!.versionNote, undefined);
		assert.equal(machineCard(bare("unavailable", []), null).services[0]!.versionNote, "reports unavailable");
		assert.equal(machineCard(bare("signed-out", []), null).services[0]!.versionNote, "sign in on this device first");
		assert.deepEqual(machineCard(bare("unavailable", []), null).channel, { value: null, editable: false, note: "Change it from that machine's console", missing: "reports unavailable" });
	});
});

describe("machineCard log fetching", () => {
	const down = (over: Partial<HostCard> = {}) => card({ hub: link("hubd", "hubd", { status: "down", error: "refused" }), workerds: [{ link: link("workerd", "workerd", { status: "down", error: "refused" }), wolves: [] }], ...over });
	it("never asks a machine for logs unless it advertised logs.fetch", () => {
		assert.deepEqual(machineCard(down(), null).services.map((s) => s.logService), [undefined, undefined]);
		assert.deepEqual(machineCard(down({ commands: ["wolves.restart"] }), null).services.map((s) => s.logService), [undefined, undefined]);
		assert.deepEqual(machineCard(down({ commands: ["logs.fetch"] }), null).services.map((s) => s.logService), ["hubd", "workerd"]);
	});
	it("does not ask a Mac for the service logs it does not serve", () => {
		const v = machineCard(down({ commands: ["logs.fetch"], facts: { host: "Mac", services: [], stores: [], backups: "" } }), null);
		assert.deepEqual(v.services.map((s) => s.logService), [undefined, undefined]);
	});
	it("offers neither restart nor log fetch when the hub does not list the host", () => {
		const v = machineCard(down({ hubId: undefined, commands: ["logs.fetch", "workerd.restart"] }), null);
		assert.deepEqual(v.services.map((s) => [s.logService, s.restart]), [[undefined, undefined], [undefined, undefined]]);
	});
});

describe("machineCard restart, per down service from what the machine advertises", () => {
	const downWorkerd = (over: Partial<HostCard> = {}) => card({ hub: link("hubd", "hubd"), workerds: [{ link: link("workerd", "workerd", { status: "down", error: "refused" }), wolves: [link("wolfd@ada", "wolfd", { status: "down", error: "wolf_failed" })] }], ...over });
	it("offers each down service its own restart only when that command is advertised, and none on a running one", () => {
		const all = machineCard(downWorkerd({ commands: ["wolves.restart", "workerd.restart"] }), null);
		assert.deepEqual(all.services.map((s) => [s.kind, s.restart]), [["hubd", undefined], ["wolfd", "wolves.restart"], ["workerd", "workerd.restart"]]);
		const up = machineCard(card({ commands: ["wolves.restart", "workerd.restart"], workerds: [{ link: link("workerd", "workerd"), wolves: [link("wolfd@ada", "wolfd")] }] }), null);
		assert.deepEqual(up.services.map((s) => s.restart), [undefined, undefined]);
		const onlyWolves = machineCard(downWorkerd({ commands: ["wolves.restart"] }), null);
		assert.deepEqual(onlyWolves.services.map((s) => s.restart), [undefined, "wolves.restart", undefined]);
	});
	it("a Mac whose background service is down and not advertised gets the quit-and-reopen hint; any other machine the generic one", () => {
		const mac = machineCard(downWorkerd({ commands: ["wolves.restart"], facts: { host: "Mac", services: [], stores: [], backups: "" } }), null);
		assert.equal(mac.services.find((s) => s.kind === "workerd")!.hint, "Restart isn't available on the Mac app; quit and reopen it");
		const other = machineCard(downWorkerd({ commands: ["wolves.restart"] }), null);
		assert.equal(other.services.find((s) => s.kind === "workerd")!.hint, "This machine can't restart it from here");
	});
	it("an older hub that advertises nothing gets no restart on a non-Mac machine, only the no-restart hint", () => {
		const v = machineCard(downWorkerd({ commands: undefined }), null);
		assert.deepEqual(v.services.map((s) => s.restart), [undefined, undefined, undefined]);
		assert.equal(v.services.find((s) => s.kind === "workerd")!.hint, "This machine can't restart it from here");
	});
	it("a label of Mac alone decides nothing: with nothing advertised no restart is offered", () => {
		const v = machineCard(downWorkerd({ label: "Mac" }), null);
		assert.deepEqual(v.services.map((s) => s.restart), [undefined, undefined, undefined]);
	});
});

describe("restartSummary", () => {
	it("keeps the hub's 'could not confirm' words and falls back to the hint when the machine refuses", () => {
		assert.equal(restartSummary({ id: "c", ok: true, message: "restarted, but could not confirm" }, "hint"), "restarted, but could not confirm");
		assert.equal(restartSummary({ id: "d", ok: false, code: "not_sent_unsupported" }, "the hint"), "the hint");
		assert.equal(restartSummary({ id: "c", ok: false, code: "not_sent_offline" }, "hint"), "The machine is offline; nothing was sent");
		assert.equal(restartSummary({ id: "d", ok: true }, "hint"), "Restart sent");
	});
});

describe("logLines", () => {
	it("never shows a raw code: an unsupported or unknown service becomes a plain sentence", () => {
		for (const code of ["not_sent_unsupported", "unknown_service"]) {
			const { error } = logLines({ id: "c", ok: false, code });
			assert.equal(error, "This machine has no log for that service");
		}
		assert.equal(logLines({ id: "c", ok: false, code: "internal" }).error, "Could not fetch the log");
	});
	it("returns the lines exactly as sent, or the failure in words", () => {
		assert.deepEqual(logLines({ id: "c", ok: true, data: { lines: ["a  b", "token=abc"], truncated: false } }), { lines: ["a  b", "token=abc"], error: null });
		assert.deepEqual(logLines({ id: "c", ok: false, code: "timeout", message: "no answer" }), { lines: [], error: "no answer" });
	});
});
