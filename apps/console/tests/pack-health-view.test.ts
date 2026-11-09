import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { errorText, historySummary, packSummary, restartOutcome, type HealthLink } from "../src/core/pack-health-view.ts";

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
