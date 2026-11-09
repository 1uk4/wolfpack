import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { errorText, historySummary, logsOutcome, packSummary, restartOutcome, rollbackFinished, rollbackOutcome, rollbackQuestion, rowActions, type HealthLink } from "../src/core/pack-health-view.ts";

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
