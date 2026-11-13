import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { errorText, machineServices, offersOwnControls, packSummary, restartOutcome, rollbackFinished, rollbackOutcome, rollbackQuestion, machineServiceCards, serviceCards, updateFinished, updateOffered, updateOutcome, updateQuestion, updateWarnings, rollbackOffered, type HealthLink } from "../../../src/core/pack/pack-health-view.ts";

const NOW = Date.parse("2026-11-09T14:10:00Z");
const link = (id: string, status: HealthLink["status"], over: Partial<HealthLink> = {}): HealthLink => ({
	id,
	kind: id === "hubd" ? "hubd" : id.startsWith("wolfd@") ? "wolfd" : "workerd",
	status,
	responseMs: 12,
	lagMs: 3,
	lastOkAt: "2026-11-09T14:09:55Z",
	lastCheckedAt: "2026-11-09T14:09:58Z",
	error: null,
	version: "0.1.14",
	uptimeS: 600,
	history: [{ status, at: "2026-11-09T13:00:00Z" }],
	lastRestart: null,
	restartable: true,
	...over,
});
const snap = (...links: HealthLink[]) => ({ checkedAt: "2026-11-09T14:09:58Z", intervalMs: 5000, links });

describe("service cards (one per service in the pack panel)", () => {
	it("gives console, hubd, wolfd and workerd one card each with running and latest version, Update only when behind, Roll back only when an older release is kept", () => {
		const links = [link("hubd", "ok", { version: "0.1.14" }), link("workerd", "down", { version: "0.1.5" }), link("wolfd@hal", "ok", { version: "0.1.14" })];
		const actions = {
			systemd: true,
			rollback: [
				{ service: "console", from: "0.1.19", to: "0.1.18" },
				{ service: "workerd", from: "0.1.5", to: "0.1.4" },
			],
		};
		const units = [{ component: "hubd", from: "0.1.14", to: "0.1.15-main.2" }];
		assert.deepEqual(
			serviceCards(links, actions, units).map((c) => [c.component, c.running, c.latest, c.canUpdate, c.rollbackTo, c.tone]),
			[
				["console", "0.1.19", null, false, "0.1.18", "green"],
				["hubd", "0.1.14", "0.1.15-main.2", true, null, "green"],
				["wolfd", "0.1.14", null, false, null, "green"],
				["workerd", "0.1.5", null, false, "0.1.4", "red"],
			],
		);
		assert.equal(serviceCards(links, { systemd: false, rollback: [] }, units).some((c) => c.canUpdate || c.rollbackTo !== null), false);
	});
});

describe("service rows per machine (the inventory panel)", () => {
	const inv = (kind: "workerd" | "wolfd" | "hubd", id: string, over: Record<string, unknown> = {}) => ({ machine: "sfo-01", kind, id, ageS: 4, latest: null, ...over }) as Parameters<typeof machineServices>[1][number];
	const remote = { console: false, hub: null, wolves: [] };

	it("lists wolves under their workerd with their own version, folds the hub link into the workerd row, and rounds ms to whole numbers; response shows only where measured", () => {
		const card = { ...remote, workerds: [{ link: link("hub-link@sfo", "ok", { kind: "hublink", version: null }), wolves: [] }] };
		const rows = machineServices(card, [
			inv("workerd", "sfo", { version: "0.1.20", channel: "stable", uptimeS: 90, lagMs: 3.6 }),
			inv("wolfd", "hal", { parent: "sfo", version: "0.1.19", channel: "stable", responseMs: 11.4, lagMs: 2.2, latest: "0.1.20" }),
			inv("wolfd", "ada", { parent: "sfo" }),
		], null);
		assert.equal(rows.length, 1);
		assert.deepEqual([rows[0]!.name, rows[0]!.version, rows[0]!.channel, rows[0]!.verdict, rows[0]!.response, rows[0]!.lag, rows[0]!.status], ["sfo", "0.1.20", "stable", "up to date", "—", "4 ms", "ok"]);
		assert.deepEqual(rows[0]!.children.map((c) => [c.name, c.version, c.verdict, c.response, c.lag]), [["hal", "0.1.19", "behind → v0.1.20", "11 ms", "2 ms"], ["ada", null, "version unknown", "—", "—"]]);
	});

	it("shows each wolf once when hub-presence links and inventory entries both name it (Mac: no workerd link), with the inventory version and the link's status", () => {
		const card = { console: false, hub: null, workerds: [{ link: link("hub-link@mac-1uk4", "ok", { kind: "hublink", version: null, host: "lukas-macbook-pro" }), wolves: [] }], wolves: [link("wolfd@1uk4", "degraded", { version: null }), link("wolfd@jack", "ok", { version: null })] };
		const rows = machineServices(card, [
			inv("workerd", "mac-1uk4", { version: "0.1.19-main.5" }),
			inv("wolfd", "1uk4", { parent: "mac-1uk4", version: "0.1.19-main.5" }),
			inv("wolfd", "jack", { parent: "mac-1uk4", version: "0.1.19-main.5" }),
		], null);
		const wolves = rows.flatMap((r) => [r, ...r.children]).filter((r) => r.kind === "wolfd");
		assert.deepEqual(wolves.map((w) => [w.name, w.version, w.status]), [["1uk4", "0.1.19-main.5", "degraded"], ["jack", "0.1.19-main.5", "ok"]]);
	});

	it("folds the console's local workerd probe into the one inventory workerd on its machine (ids differ), one row per wolf", () => {
		const card = { console: true, hub: null, wolves: [], workerds: [{ link: link("workerd", "ok", { version: "0.1.10-main.5", host: "lukas-macbook-pro" }), wolves: [link("wolfd@1uk4", "ok", { via: "workerd", version: null }), link("wolfd@jack", "degraded", { via: "workerd", version: null })] }] };
		const m = { machine: "lukas-macbook-pro" };
		const rows = machineServices(card, [
			inv("workerd", "mac-1uk4", { ...m, version: "0.1.10-main.5", channel: "main" }),
			inv("wolfd", "1uk4", { ...m, parent: "mac-1uk4", version: "0.1.19-main.5" }),
			inv("wolfd", "jack", { ...m, parent: "mac-1uk4", version: "0.1.19-main.5" }),
		], null).filter((r) => r.kind !== "console");
		assert.equal(rows.length, 1);
		assert.deepEqual([rows[0]!.name, rows[0]!.status, rows[0]!.version], ["mac-1uk4", "ok", "0.1.10-main.5"]);
		assert.deepEqual(rows[0]!.children.map((c) => [c.name, c.status, c.version]), [["1uk4", "ok", "0.1.19-main.5"], ["jack", "degraded", "0.1.19-main.5"]]);
	});

	it("keeps one row per wolf when the workerd link carries the wolves", () => {
		const card = { ...remote, workerds: [{ link: link("workerd", "ok"), wolves: [link("wolfd@hal", "ok", { version: null })] }] };
		const rows = machineServices(card, [inv("workerd", "workerd", { version: "0.1.19" }), inv("wolfd", "hal", { parent: "workerd", version: "0.1.19" })], null);
		assert.deepEqual(rows.flatMap((r) => r.children).map((c) => [c.name, c.version]), [["hal", "0.1.19"]]);
		assert.equal(rows.length, 1);
	});

	it("shows response in whole ms on the hub, a local workerd and its wolves, where the console measured a round trip", () => {
		const card = { console: false, hub: link("hubd", "ok", { responseMs: 70.6 }), workerds: [{ link: link("workerd", "ok", { responseMs: 4.2 }), wolves: [link("wolfd@hal", "ok", { responseMs: 9.4 })] }], wolves: [] };
		const rows = machineServices(card, [], null);
		assert.deepEqual(rows.map((r) => [r.name, r.response]), [["Hub", "71 ms"], ["workerd", "4 ms"]]);
		assert.equal(rows[1]!.children[0]!.response, "9 ms");
	});

	it("the own machine's Console row takes version, channel, uptime and lag from the console's own entry, and the newer version from the update units", () => {
		const row = (version: string) => machineServices({ ...remote, console: true, workerds: [] }, [], { channel: "main", latest: { console: "0.1.21" }, consoleVersion: null, self: { machine: "luka-air", kind: "console", id: "console", version, channel: "main", uptimeS: 90, lagMs: 3.6 } })[0]!;
		const r = row("0.1.20");
		assert.deepEqual([r.version, r.channel, r.verdict, r.uptime, r.lag, r.response], ["0.1.20", "main", "behind → v0.1.21", "1m", "4 ms", "—"]);
		assert.equal(row("0.1.0-dev").verdict, "dev build");
	});

	it("says 'dev build' only for an unpublished checkout, and gives no verdict to a row that reports no channel", () => {
		const card = { ...remote, workerds: [{ link: link("workerd", "ok"), wolves: [] }, { link: link("workerd-b", "ok"), wolves: [] }] };
		const rows = machineServices(card, [inv("workerd", "workerd", { version: "0.1.0-dev", channel: "main" }), inv("workerd", "workerd-b", { version: "0.1.5" })], null);
		assert.deepEqual(rows.map((r) => r.verdict), ["dev build", ""]);
	});
});

describe("machines that go quiet", () => {
	it("a machine with hub presence but no inventory still lists its workerd (version unknown); a mapped machine nothing knows lists its mapped services as 'no report' with an unknown status", () => {
		const seen = machineServices({ console: false, hub: null, workerds: [{ link: link("hub-link@sfo", "ok", { kind: "hublink", version: null }), wolves: [] }], wolves: [] }, [], null);
		assert.deepEqual(seen.map((r) => [r.name, r.status, r.verdict, r.noReport ?? false]), [["sfo", "ok", "version unknown", false]]);
		const facts = { host: "Mac", services: [{ name: "console", at: "", what: "" }, { name: "workerd", at: "", what: "" }], stores: [], backups: "" };
		const gone = machineServices({ console: false, hub: null, workerds: [], wolves: [], facts }, [], null);
		assert.deepEqual(gone.map((r) => [r.name, r.status, r.version, r.uptime, r.noReport]), [["Console", "unknown", null, "—", true], ["workerd", "unknown", null, "—", true]]);
	});

	it("the Update / Roll back controls belong only to a checked card on the console's own machine", () => {
		assert.equal(offersOwnControls({ console: true, checked: true }), true);
		assert.equal(offersOwnControls({ console: false, checked: true }), false);
		assert.equal(offersOwnControls({ console: true, checked: false }), false);
	});
});

describe("update controls per machine", () => {
	it("offers the service cards (Update, Roll back) only on the console's own machine, built from that machine's links", () => {
		const actions = { systemd: true, rollback: [{ service: "hubd", from: "0.1.14", to: "0.1.13", last: null }] } as unknown as Parameters<typeof serviceCards>[1];
		const units = [{ component: "hubd", from: "0.1.14", to: "0.1.15" }];
		const here = { console: true, hub: link("hubd", "ok"), workerds: [{ link: link("workerd", "ok"), wolves: [link("wolfd@hal", "ok")] }], wolves: [] };
		const other = { console: false, hub: null, workerds: [{ link: link("workerd-ci", "ok", { version: "0.1.2" }), wolves: [] }], wolves: [] };
		assert.deepEqual(machineServiceCards(here, actions, units).map((c) => [c.component, c.canUpdate]), [["console", false], ["hubd", true], ["wolfd", false], ["workerd", false]]);
		assert.deepEqual(machineServiceCards(other, actions, units), []);
	});
});

describe("pack health summary (the sidebar bar)", () => {
	it("is green 'All good' when every link is ok", () => {
		assert.deepEqual(packSummary({ snapshot: snap(link("hubd", "ok"), link("workerd", "ok"), link("wolfd@hal", "ok")), reachable: true, now: NOW }), { tone: "green", label: "All good" });
	});

	it("names a single broken link, red for down/frozen and amber for restarting", () => {
		assert.deepEqual(packSummary({ snapshot: snap(link("hubd", "down"), link("workerd", "ok")), reachable: true, now: NOW }), { tone: "red", label: "Hub down" });
		assert.deepEqual(packSummary({ snapshot: snap(link("hubd", "ok"), link("wolfd@hal", "frozen")), reachable: true, now: NOW }), { tone: "red", label: "hal frozen" });
		assert.deepEqual(packSummary({ snapshot: snap(link("hubd", "restarting"), link("workerd", "ok")), reachable: true, now: NOW }), { tone: "amber", label: "Hub restarting…" });
	});

	it("says 'Recovering…' when every issue is only recovering, and counts mixed issues with the worst colour", () => {
		assert.deepEqual(packSummary({ snapshot: snap(link("hubd", "recovering"), link("workerd", "recovering"), link("wolfd@hal", "ok")), reachable: true, now: NOW }), { tone: "amber", label: "Recovering…" });
		assert.deepEqual(packSummary({ snapshot: snap(link("hubd", "degraded"), link("workerd", "down"), link("wolfd@hal", "unknown")), reachable: true, now: NOW }), { tone: "red", label: "3 issues" });
		assert.deepEqual(packSummary({ snapshot: snap(link("hubd", "ok"), link("wolfd@hal", "unknown")), reachable: true, now: NOW }), { tone: "grey", label: "hal unknown" });
	});

	it("counts a host the hub reports offline (and its wolves), not one asleep, nor rows the hub reported before it stopped answering", () => {
		const hub = (id: string, status: HealthLink["status"], error: string) => link(id, status, { kind: id.startsWith("wolfd@") ? "wolfd" : "hublink", source: "hub", error });
		assert.deepEqual(packSummary({ snapshot: snap(link("hubd", "ok"), hub("hub-link@lap", "unknown", "host_asleep"), hub("wolfd@lappy", "unknown", "host_asleep")), reachable: true, now: NOW }), { tone: "green", label: "All good" });
		assert.deepEqual(packSummary({ snapshot: snap(link("hubd", "ok"), hub("hub-link@cron", "down", "host_offline"), hub("wolfd@job", "down", "wolf_offline")), reachable: true, now: NOW }), { tone: "red", label: "2 issues" });
		assert.deepEqual(packSummary({ snapshot: snap(link("hubd", "down"), hub("hub-link@cron", "unknown", "hub_stale")), reachable: true, now: NOW }), { tone: "red", label: "Hub down" });
	});

	it("says '<name> back' for a few seconds after a link returns to ok", () => {
		const back = link("hubd", "ok", { history: [{ status: "recovering", at: "2026-11-09T14:09:30Z" }, { status: "ok", at: "2026-11-09T14:09:56Z" }] });
		assert.deepEqual(packSummary({ snapshot: snap(back, link("workerd", "ok")), reachable: true, now: NOW }), { tone: "green", label: "Hub back" });
		assert.deepEqual(packSummary({ snapshot: snap(back, link("workerd", "ok")), reachable: true, now: NOW + 30_000 }), { tone: "green", label: "All good" });
	});

	it("keeps the last snapshot's age when the console itself is unreachable, and never blanks", () => {
		assert.deepEqual(packSummary({ snapshot: snap(link("hubd", "ok")), reachable: false, lastSeenAt: NOW - 3 * 60_000, now: NOW }), { tone: "red", label: "Console unreachable · last seen 3m ago" });
		assert.deepEqual(packSummary({ snapshot: null, reachable: false, now: NOW }), { tone: "red", label: "Console unreachable" });
		assert.deepEqual(packSummary({ snapshot: null, reachable: true, now: NOW }), { tone: "grey", label: "Checking…" });
	});
});

describe("restart response handling", () => {
	it("turns 202 into issued and any other failure into an error the row shows", () => {
		assert.deepEqual(restartOutcome(202, null), { kind: "issued" });
		assert.deepEqual(restartOutcome(500, null), { kind: "error", message: "Restart failed (HTTP 500)" });
	});

	it("waits Retry-After seconds on 429, 5 s without one, and never more than 60 s", () => {
		assert.deepEqual(restartOutcome(429, "12"), { kind: "wait", retryS: 12 });
		assert.deepEqual(restartOutcome(429, null), { kind: "wait", retryS: 5 });
		assert.deepEqual(restartOutcome(429, "3600"), { kind: "wait", retryS: 60 });
	});
});

describe("error codes in plain words", () => {
	it("reads http_<n> and wolf_<state> codes, passes an unknown code through, and says nothing for no error", () => {
		assert.equal(errorText("http_503"), "Answered with HTTP 503");
		assert.equal(errorText("wolf_failed"), "Its workerd reports it failed");
		assert.equal(errorText("something_new"), "something_new");
		assert.equal(errorText(null), null);
	});
});

describe("service actions per row", () => {
	it("never offers a roll back that would go to a newer release (after a rollback, previous is the release just left); unknown versions stay offered", () => {
		const on = (from: string | null, to: string | null) => rollbackOffered({ from, to });
		assert.equal(on("0.1.13", "0.1.14+abc"), false);
		assert.equal(on("0.1.9", "0.1.10"), false);
		assert.equal(on("0.1.10", "0.1.9"), true);
		assert.equal(on("0.1.18+b", "0.1.18+a"), true);
		assert.equal(on(null, "0.1.20"), true);
		assert.equal(on("0.1.20", null), true);
	});

	it("orders main prereleases below their release when deciding the roll back", () => {
		const on = (from: string | null, to: string | null) => rollbackOffered({ from, to });
		assert.equal(on("0.1.21", "0.1.21-main.3"), true);
		assert.equal(on("0.1.21-main.3", "0.1.21"), false);
		assert.equal(on("0.1.21-main.10", "0.1.21-main.9"), true);
		assert.equal(on("0.1.21-main.9", "0.1.21-main.10"), false);
		assert.equal(rollbackQuestion("hubd", "0.1.21", "0.1.21-main.3"), "Roll hubd back to v0.1.21-main.3?");
	});

	it("names the target in the confirm: the X.Y.Z, the build only when the versions are equal, and says when a version is unknown", () => {
		assert.equal(rollbackQuestion("hubd", "0.1.14+abc", "0.1.13+def"), "Roll hubd back to v0.1.13?");
		assert.equal(rollbackQuestion("hubd", "0.1.18+b", "0.1.18+a"), "Roll hubd back to v0.1.18+a?");
		assert.equal(rollbackQuestion("hubd", "0.1.14", null), "Roll hubd back to the previous release (its version is unknown)?");
		assert.equal(rollbackQuestion("hubd", null, "0.1.13"), "Roll hubd back to v0.1.13 (the running version is unknown)?");
	});

});

describe("rollback unit result", () => {
	it("is still running until the unit reports a run newer than the one seen at send; a failure names the script's exit in plain words", () => {
		const before = "2026-11-09T09:00:00.000Z";
		const at = "2026-11-09T10:00:00.000Z";
		assert.equal(rollbackFinished(null, null), null);
		assert.equal(rollbackFinished({ result: "running", exitStatus: null, at: null }, before), null);
		assert.equal(rollbackFinished({ result: "exit-code", exitStatus: 4, at: before }, before), null, "the run seen at send is an old one");
		assert.deepEqual(rollbackFinished({ result: "success", exitStatus: 0, at }, before), { ok: true });
		assert.deepEqual(rollbackFinished({ result: "exit-code", exitStatus: 4, at }, before), { ok: false, message: "Rollback failed (exit 4: needs a person) — see Logs" });
		assert.deepEqual(rollbackFinished({ result: "exit-code", exitStatus: 1, at }, null), { ok: false, message: "Rollback failed (exit 1: refused, nothing changed) — see Logs" });
		assert.deepEqual(rollbackFinished({ result: "timeout", exitStatus: 0, at }, before), { ok: false, message: "Rollback failed (timed out) — see Logs" });
		// A start the unit's assert refused: the server reports it at the assert time, newer than the success seen at send.
		assert.deepEqual(rollbackFinished({ result: "assert", exitStatus: null, at }, before), { ok: false, message: "Rollback failed (rollback script or previous release missing on the host) — see Logs" });
	});
});

describe("update button", () => {
	const units = [{ component: "hubd", from: "0.1.14", to: "0.1.15" }, { component: "console", from: null, to: "0.1.19" }];

	it("is offered only under systemd and when at least one unit has a newer target", () => {
		assert.equal(updateOffered({ systemd: true, rollback: [] }, units), true);
		assert.equal(updateOffered({ systemd: true, rollback: [] }, []), false);
		assert.equal(updateOffered({ systemd: false, rollback: [] }, units), false);
		assert.equal(updateOffered(undefined, units), false);
	});

	it("asks with every unit's current → target and warns that hubd and the console restart", () => {
		assert.equal(
			updateQuestion(units),
			"Update to the latest stable release? hubd v0.1.14 → v0.1.15, console (unknown) → v0.1.19. hubd and the console restart, so this page drops for a few seconds.",
		);
	});

	it("is finished only by a run newer than the one seen at send; a failure says so and points to Logs", () => {
		const before = "2026-11-09T09:00:00.000Z";
		const at = "2026-11-09T10:00:00.000Z";
		assert.equal(updateFinished({ result: "running", exitStatus: null, at: null }, before), null);
		assert.equal(updateFinished({ result: "exit-code", exitStatus: 1, at: before }, before), null);
		assert.deepEqual(updateFinished({ result: "success", exitStatus: 0, at }, before), { ok: true });
		assert.deepEqual(updateFinished({ result: "exit-code", exitStatus: 1, at }, before), { ok: false, message: "Update failed (exit 1) — see Logs" });
		assert.deepEqual(updateFinished({ result: "timeout", exitStatus: 0, at }, null), { ok: false, message: "Update failed (timed out) — see Logs" });
	});

	it("names a switched-off host, a held lock and a missing script instead of a false 'Updated', and refuses 'Updated' while a component is still behind", () => {
		const before = "2026-11-09T09:00:00.000Z";
		const at = "2026-11-09T10:00:00.000Z";
		const fin = (result: string, exitStatus: number) => updateFinished({ result, exitStatus, at }, before);
		assert.deepEqual(fin("exit-code", 3), { ok: false, message: "Update failed (auto-update is switched off on the host (kill switch)) — see Logs" });
		assert.deepEqual(fin("exit-code", 4), { ok: false, message: "Update failed (another update run holds the lock) — see Logs" });
		assert.deepEqual(fin("exit-code", 203), { ok: false, message: "Update failed (update script missing on the host) — see Logs" });
		assert.deepEqual(fin("exec", 203), { ok: false, message: "Update failed (update script missing on the host) — see Logs" });
		// A run that ended ok but left a component behind changed nothing for the owner.
		assert.deepEqual(updateFinished({ result: "success", exitStatus: 0, at }, before, 1), { ok: false, message: "Nothing changed — see Logs" });
		// The run finished before the first poll after send: the baseline taken before the send still counts it.
		assert.deepEqual(updateFinished({ result: "success", exitStatus: 0, at }, before, 0), { ok: true });
	});

	it("turns the POST status into started, nothing to update, already running, or a countdown", () => {
		assert.deepEqual(updateOutcome(202, null), { kind: "issued" });
		assert.deepEqual(updateOutcome(409, null, { code: "no_update" }, "sfo-01"), { kind: "error", message: "Already up to date on sfo-01" });
		assert.deepEqual(updateOutcome(409, null, { code: "up_to_date" }), { kind: "error", message: "Already up to date" });
		assert.deepEqual(updateOutcome(409, null, { code: "running" }), { kind: "error", message: "An update is already running" });
		assert.deepEqual(updateOutcome(429, "240"), { kind: "wait", retryS: 240 });
		assert.deepEqual(updateOutcome(502, null), { kind: "error", message: "systemctl refused the update (is the update unit and polkit rule installed?)" });
	});
});

describe("update warnings (sidebar notice)", () => {
	const now = Date.parse("2026-11-09T12:00:00Z");
	const st = (over: object) => ({ updateStatus: { state: "idle", lastCheck: "2026-11-09T11:20:00Z", ...over } });
	it("names the machine on a stale warning and says manual mode, not stale, when auto-update is off; one line per machine", () => {
		const rows = [st({ host: "sfo-01", stale: true }), st({ host: "sfo-01", stale: true }), st({ host: "hal", manual: true }), {}];
		assert.deepEqual(updateWarnings(rows, now), ["Auto-update hasn't run on sfo-01 for 40m — see deploy/auto-update/RUNBOOK.md", "Manual updates: auto-update is off on hal"]);
	});
});

describe("logs and rollback response handling", () => {
	it("turns a rollback 202 into started, 409 into nothing to go back to (or a newer kept release), and waits up to the full 10 min on 429", () => {
		assert.deepEqual(rollbackOutcome(202, null), { kind: "issued" });
		assert.deepEqual(rollbackOutcome(409, null), { kind: "error", message: "No previous release is kept on this host" });
		assert.deepEqual(rollbackOutcome(409, null, { code: "previous_is_newer" }), { kind: "error", message: "The kept release is newer; deploy instead of rolling back" });
		assert.deepEqual(rollbackOutcome(502, null), { kind: "error", message: "systemctl refused the rollback (is the rollback unit and polkit rule installed?)" });
		assert.deepEqual(rollbackOutcome(429, "360"), { kind: "wait", retryS: 360 });
		assert.deepEqual(rollbackOutcome(429, "99999"), { kind: "wait", retryS: 600 });
	});
});
