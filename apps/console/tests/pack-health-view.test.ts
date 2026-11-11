import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { errorText, historySummary, logsOutcome, packSummary, restartOutcome, rollbackFinished, rollbackOutcome, rollbackQuestion, rowActions, machineServiceCards, serviceCards, updateFinished, updateOffered, updateOutcome, updateQuestion, type HealthLink } from "../src/core/pack-health-view.ts";

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

describe("history summary", () => {
	it("reads the recent transitions oldest first, with local HH:MM and no time on the passing recovering step", () => {
		const at = (hm: string) => new Date(`2026-11-09T${hm}:00`).toISOString(); // local time, as the console shows it
		const h: HealthLink["history"] = [
			{ status: "ok", at: at("13:00") },
			{ status: "down", at: at("14:02") },
			{ status: "restarting", at: at("14:03") },
			{ status: "recovering", at: at("14:03") },
			{ status: "ok", at: at("14:04") },
		];
		assert.equal(historySummary(h, 4), "down 14:02 → restarting 14:03 → recovering → ok 14:04");
	});

	it("says nothing when the link has only ever had one state", () => {
		assert.equal(historySummary([{ status: "ok", at: "2026-11-09T13:00:00Z" }]), "");
		assert.equal(historySummary([]), "");
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
	it("offers roll back only for hubd and the workerd link unit with a kept previous release, naming the target version", () => {
		const actions = { systemd: true, rollback: [{ service: "hubd", from: "0.1.14", to: "0.1.13" }, { service: "workerd", from: "0.1.5", to: null }] };
		assert.deepEqual(rowActions(link("hubd", "ok"), actions), { logs: true, rollback: { service: "hubd", to: "0.1.13" }, macCommands: null, restart: true });
		assert.deepEqual(rowActions(link("workerd", "ok"), actions), { logs: true, rollback: { service: "workerd", to: null }, macCommands: null, restart: true });
		assert.deepEqual(rowActions(link("workerd-wolves", "ok"), actions), { logs: true, rollback: null, macCommands: null, restart: true });
		assert.deepEqual(rowActions(link("wolfd@hal", "ok"), actions), { logs: true, rollback: null, macCommands: null, restart: true });
		assert.deepEqual(rowActions(link("hubd", "ok", { restartable: false }), actions), { logs: false, rollback: { service: "hubd", to: "0.1.13" }, macCommands: null, restart: false });
	});

	it("never offers a roll back that would go to a newer release (after a rollback, previous is the release just left); unknown versions stay offered", () => {
		const on = (from: string | null, to: string | null) => rowActions(link("hubd", "ok"), { systemd: true, rollback: [{ service: "hubd", from, to }] }).rollback;
		assert.equal(on("0.1.13", "0.1.14+abc"), null);
		assert.equal(on("0.1.9", "0.1.10"), null);
		assert.deepEqual(on("0.1.10", "0.1.9"), { service: "hubd", to: "0.1.9" });
		assert.deepEqual(on("0.1.18+b", "0.1.18+a"), { service: "hubd", to: "0.1.18+a" });
		assert.deepEqual(on(null, "0.1.20"), { service: "hubd", to: "0.1.20" });
		assert.deepEqual(on("0.1.20", null), { service: "hubd", to: null });
	});

	it("orders main prereleases below their release when deciding the roll back", () => {
		const on = (from: string | null, to: string | null) => rowActions(link("hubd", "ok"), { systemd: true, rollback: [{ service: "hubd", from, to }] }).rollback;
		assert.deepEqual(on("0.1.21", "0.1.21-main.3"), { service: "hubd", to: "0.1.21-main.3" });
		assert.equal(on("0.1.21-main.3", "0.1.21"), null);
		assert.deepEqual(on("0.1.21-main.10", "0.1.21-main.9"), { service: "hubd", to: "0.1.21-main.9" });
		assert.equal(on("0.1.21-main.9", "0.1.21-main.10"), null);
		assert.equal(rollbackQuestion("hubd", "0.1.21", "0.1.21-main.3"), "Roll hubd back to v0.1.21-main.3?");
	});

	it("names the target in the confirm: the X.Y.Z, the build only when the versions are equal, and says when a version is unknown", () => {
		assert.equal(rollbackQuestion("hubd", "0.1.14+abc", "0.1.13+def"), "Roll hubd back to v0.1.13?");
		assert.equal(rollbackQuestion("hubd", "0.1.18+b", "0.1.18+a"), "Roll hubd back to v0.1.18+a?");
		assert.equal(rollbackQuestion("hubd", "0.1.14", null), "Roll hubd back to the previous release (its version is unknown)?");
		assert.equal(rollbackQuestion("hubd", null, "0.1.13"), "Roll hubd back to v0.1.13 (the running version is unknown)?");
	});

	it("off systemd (the Mac stack) offers no restart, logs or rollback, only copyable stack commands on workerd and wolf rows; an older server without actions counts as off", () => {
		const mac = { systemd: false, rollback: [] };
		const cmds = ["pnpm stack restart", "tail -n 100 ~/wolves/local/logs/stack.log"];
		assert.deepEqual(rowActions(link("workerd", "ok"), mac), { logs: false, rollback: null, macCommands: cmds, restart: false });
		assert.deepEqual(rowActions(link("wolfd@hal", "down"), undefined), { logs: false, rollback: null, macCommands: cmds, restart: false });
		assert.deepEqual(rowActions(link("hubd", "ok"), mac), { logs: false, rollback: null, macCommands: null, restart: false });
	});

	it("offers nothing on a row known only from the hub, even under systemd", () => {
		const actions = { systemd: true, rollback: [{ service: "workerd", from: "0.1.5", to: "0.1.4" }] };
		const none = { logs: false, rollback: null, macCommands: null, restart: false };
		assert.deepEqual(rowActions(link("wolfd@ada", "ok", { source: "hub" }), actions), none);
		assert.deepEqual(rowActions(link("hub-link@lap", "ok", { kind: "hublink", source: "hub", restartable: false }), { systemd: false, rollback: [] }), none);
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
		assert.deepEqual(updateOutcome(409, null, { code: "no_update" }), { kind: "error", message: "Nothing is behind the latest stable release" });
		assert.deepEqual(updateOutcome(409, null, { code: "running" }), { kind: "error", message: "An update is already running" });
		assert.deepEqual(updateOutcome(429, "240"), { kind: "wait", retryS: 240 });
		assert.deepEqual(updateOutcome(502, null), { kind: "error", message: "systemctl refused the update (is the update unit and polkit rule installed?)" });
	});
});

describe("logs and rollback response handling", () => {
	it("shows the lines on 200 and names a denied journal, a host without journalctl and a refused sign-in in plain words", () => {
		assert.deepEqual(logsOutcome(200, { lines: ["a", "b"], truncated: true }, null), { kind: "lines", lines: ["a", "b"], truncated: true });
		assert.deepEqual(logsOutcome(502, { code: "journal_denied" }, null), { kind: "error", message: "The console cannot read the system journal (add its user to systemd-journal)" });
		assert.deepEqual(logsOutcome(501, { code: "unsupported" }, null), { kind: "error", message: "No system journal on this host" });
		assert.deepEqual(logsOutcome(401, { code: "unauthorized" }, null), { kind: "error", message: "Sign in with the console once while the hub is up" });
		assert.deepEqual(logsOutcome(429, null, "3"), { kind: "wait", retryS: 3 });
		assert.deepEqual(logsOutcome(0, null, null), { kind: "error", message: "Console unreachable; logs not loaded" });
	});

	it("turns a rollback 202 into started, 409 into nothing to go back to (or a newer kept release), and waits up to the full 10 min on 429", () => {
		assert.deepEqual(rollbackOutcome(202, null), { kind: "issued" });
		assert.deepEqual(rollbackOutcome(409, null), { kind: "error", message: "No previous release is kept on this host" });
		assert.deepEqual(rollbackOutcome(409, null, { code: "previous_is_newer" }), { kind: "error", message: "The kept release is newer; deploy instead of rolling back" });
		assert.deepEqual(rollbackOutcome(502, null), { kind: "error", message: "systemctl refused the rollback (is the rollback unit and polkit rule installed?)" });
		assert.deepEqual(rollbackOutcome(429, "360"), { kind: "wait", retryS: 360 });
		assert.deepEqual(rollbackOutcome(429, "99999"), { kind: "wait", retryS: 600 });
	});
});
