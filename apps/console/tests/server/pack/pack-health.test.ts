/**
 * Pack health (work-wolfpack-LUQ7C2B) at its seam: the /api/health handlers (createHealthApi) over a real monitor and restarter,
 * against real local HTTP servers that answer, hang (frozen) or refuse. The command runner is injected (no systemctl runs).
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { createHealthApi, hubTokenCheck } from "../../../src/server/pack/health-api.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createPackHealth, createRestarter, healthTargets, hubTarget, type CommandRunner, type HealthSnapshot, type LinkSnapshot } from "../../../src/server/pack/pack-health.ts";
import { createSessionWitness, setSessionWitness } from "../../../src/server/thread/session-witness.ts";
import { createReleaseReader, createRollbacker, createUpdater, type UpdateUnit } from "../../../src/server/pack/pack-actions.ts";
import { createConsoleClient, makeRequestToken } from "../../../src/server/thread/console-client.ts";

type Mode = "ok" | "hang" | "slow-lag" | "http500" | "http401" | "wrong-service" | "bad-body" | "legacy";

/**
 * A fake service: answers /healthz as `service`, or hangs; records every request it gets. `refuse()` closes the port, `back()` reopens it.
 * Any other path is an authenticated API call (the hub's GET /v1/wolves): 401 for a bearer in `revoked`, else 200 {wolves: []}.
 */
async function fakeService(service: string, extra: () => Record<string, unknown> = () => ({})) {
	let mode: Mode = "ok";
	let uptimeS = 1000;
	const revoked = new Set<string>();
	const seen: { path: string; auth?: string }[] = [];
	const make = () =>
		createServer((req, res) => {
			seen.push({ path: req.url ?? "", ...(req.headers.authorization ? { auth: req.headers.authorization } : {}) });
			if (mode === "hang") return; // a frozen event loop: never answers
			res.setHeader("Content-Type", "application/json");
			if (req.url !== "/healthz") {
				const tok = (req.headers.authorization ?? "").replace(/^Bearer /, "");
				if (!tok || revoked.has(tok)) {
					res.statusCode = 401;
					return res.end(JSON.stringify({ code: "unauthorized", message: "revoked", retryable: false }));
				}
				return res.end(JSON.stringify({ wolves: [] }));
			}
			if (mode === "http500") {
				res.statusCode = 500;
				return res.end("{}");
			}
			if (mode === "http401") {
				res.statusCode = 401; // an older hubd: /healthz sits behind auth
				return res.end(JSON.stringify({ code: "unauthorized" }));
			}
			if (mode === "bad-body") return res.end("<html>/var/lib/x: oops</html>");
			if (mode === "legacy") return res.end(JSON.stringify({ ok: true, version: "0.1.3", wolves: [] })); // an older build: no `service`
			if (mode === "wrong-service") return res.end(JSON.stringify({ ok: true, service: "nginx" }));
			const lag = mode === "slow-lag" ? { p99Ms: 900, maxMs: 4000 } : { p99Ms: 2, maxMs: 5 };
			res.end(JSON.stringify({ ok: true, service, version: "1.2.3", uptimeS, lag, ...extra() }));
		});
	let srv: Server = make();
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
	const port = (srv.address() as AddressInfo).port;
	const close = () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); });
	return {
		url: `http://127.0.0.1:${port}`,
		seen,
		revoked,
		set: (m: Mode) => { mode = m; },
		setUptime: (s: number) => { uptimeS = s; },
		refuse: close,
		back: async () => { srv = make(); await new Promise<void>((r) => srv.listen(port, "127.0.0.1", r)); },
		close,
	};
}

const T0 = Date.parse("2026-11-08T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const linkOf = (s: HealthSnapshot, id: string): LinkSnapshot => {
	const l = s.links.find((x) => x.id === id);
	assert.ok(l, `no link ${id} in ${s.links.map((x) => x.id).join(",")}`);
	return l;
};

const cleanups: (() => Promise<void>)[] = [];
after(async () => { for (const c of cleanups) await c().catch(() => {}); });

async function setup(o: { wolves?: () => unknown[]; optRoot?: string; systemd?: boolean } = {}) {
	const hub = await fakeService("hubd");
	const workerd = await fakeService("workerd", () => ({ wolves: o.wolves?.() ?? [] }));
	cleanups.push(hub.close, workerd.close);
	let t = T0;
	const clock = { now: () => t, set: (ms: number) => { t = ms; } };
	const env = { WOLFPACK_HUB_URL: hub.url, WOLFPACK_HEALTH_WORKERDS: `workerd=${workerd.url}` };
	// The rollback units' status reads (systemctl show) go to their own fake, so `runs` holds only the actions a request caused.
	const shows: string[][] = [];
	const showOut = new Map<string, string>();
	const showRun: CommandRunner = async (file, args) => {
		shows.push([file, ...args]);
		const unit = args.find((a) => a.startsWith("wolfpack-rollback@") || a.startsWith("wolfpack-auto-update-now")) ?? "";
		return { code: 0, stderr: "", stdout: showOut.get(unit) ?? "" };
	};
	const releases = createReleaseReader({ optRoot: o.optRoot ?? path.join(os.tmpdir(), "wolfpack-no-opt"), ttlMs: 0, statusTtlMs: 5_000, run: showRun, now: clock.now });
	const health = createPackHealth({ targets: healthTargets(env), timeoutMs: 300, now: clock.now, actions: () => ({ systemd: true, rollback: releases() }) });
	const runs: string[][] = [];
	let exit = 0;
	let stdout = "";
	let overflow = false;
	const run: CommandRunner = async (file, args) => { runs.push([file, ...args]); return { code: exit, stderr: "", stdout, ...(overflow ? { overflow: true } : {}) }; };
	const logs: string[] = [];
	const restarter = createRestarter({ health, run, now: clock.now, minIntervalMs: 60_000, log: (m) => logs.push(m), systemd: o.systemd ?? true });
	const witness = createSessionWitness({ now: clock.now });
	const rollbacker = createRollbacker({ releases, run, now: clock.now, log: (m) => logs.push(m) });
	let pending: UpdateUnit[] = [];
	const availableCalls = { n: 0 };
	const updater = createUpdater({ available: async () => { availableCalls.n++; return pending; }, run, show: showRun, now: clock.now, log: (m) => logs.push(m) });
	const api = createHealthApi({ health, restarter, rollbacker, updater, witness, checkToken: hubTokenCheck(hubTarget(env).wolvesUrl, { timeoutMs: 300 }), now: clock.now });
	const get = async () => (await (await api.get()).json()) as HealthSnapshot;
	const tick = async (at: number) => { clock.set(at); return health.tick(); };
	return {
		hub, workerd, clock, health, api, get, tick, runs, logs, witness, releases, shows,
		setExit: (c: number) => { exit = c; },
		setStdout: (o: string) => { stdout = o; },
		setOverflow: (v: boolean) => { overflow = v; },
		setShow: (unit: string, out: string) => { showOut.set(unit, out); },
		setPending: (u: UpdateUnit[]) => { pending = u; },
		availableCalls,
		updater,
	};
}

describe("pack health: GET /api/health", () => {
	it("gives every link a host: its own /healthz host, else its workerd's, else this console's for loopback, else the probe URL's; and lists the hosts", async () => {
		// The network boundary: each URL answers a canned /healthz body (old builds send no `host`).
		const bodies: Record<string, Record<string, unknown>> = {
			"http://sfo-01.tail9c2.ts.net:3150/healthz": { ok: true, service: "hubd" },
			"http://127.0.0.1:7141/healthz": { ok: true, service: "workerd", host: "Build-Box.local", wolves: [{ name: "hal", state: "online" }] },
			"http://127.0.0.1:7151/healthz": { ok: true, service: "workerd", wolves: [] },
			"http://100.120.154.69:7200/healthz": { ok: true, service: "wolfd" },
			"http://127.0.0.1:7300/healthz": { ok: true, service: "wolfd", host: "sfo-010" },
		};
		const refused = new Set<string>();
		const fakeFetch = (async (url: string) => {
			if (refused.has(url)) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
			return new Response(JSON.stringify(bodies[url] ?? {}), { status: bodies[url] ? 200 : 404 });
		}) as unknown as typeof fetch;
		const env = {
			WOLFPACK_HEALTH_HUB_URL: "http://sfo-01.tail9c2.ts.net:3150",
			WOLFPACK_HEALTH_WORKERDS: "workerd=http://127.0.0.1:7141,workerd-old=http://127.0.0.1:7151",
			WOLFPACK_HEALTH_WOLVES: "ada=http://100.120.154.69:7200,bob=http://127.0.0.1:7300",
			WOLFPACK_HEALTH_HOST_LABELS: "100.120.154.69=ada box",
		};
		const health = createPackHealth({ targets: healthTargets(env), fetch: fakeFetch, now: () => T0, consoleHost: "Luka-Air.local", platform: "darwin", hostLabels: env.WOLFPACK_HEALTH_HOST_LABELS, log: () => {} });
		const snap = await health.tick();
		assert.deepEqual(Object.fromEntries(snap.links.map((l) => [l.id, l.host])), {
			hubd: "sfo-01",
			workerd: "build-box",
			"workerd-old": "luka-air",
			"wolfd@ada": "100.120.154.69",
			"wolfd@bob": "sfo-010",
			"wolfd@hal": "build-box",
		});
		assert.deepEqual([...snap.hosts].sort((a, b) => a.id.localeCompare(b.id)), [
			{ id: "100.120.154.69", label: "ada box", isThisConsole: false },
			{ id: "build-box", label: "build-box", isThisConsole: false },
			{ id: "luka-air", label: "Mac", isThisConsole: true, platform: "darwin" },
			{ id: "sfo-01", label: "sfo-01", isThisConsole: false },
			{ id: "sfo-010", label: "sfo-010", isThisConsole: false }, // exact match only: a look-alike is not sfo-01
		]);
		// An outage does not move a link: the workerd that said build-box stays on build-box while it is down.
		refused.add("http://127.0.0.1:7141/healthz");
		const down = await health.tick();
		assert.equal(linkOf(down, "workerd").status, "down");
		assert.equal(linkOf(down, "workerd").host, "build-box");
	});

	it("carries this console's own entry as `self` even when the hub has no inventory", async () => {
		const fakeFetch = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
		const entry = { machine: "luka-air", kind: "console" as const, id: "console", version: "0.1.20", channel: "main" as const, uptimeS: 42, lagMs: 3 };
		const health = createPackHealth({ targets: healthTargets({}), fetch: fakeFetch, now: () => T0, consoleHost: "luka-air", platform: "darwin", log: () => {}, inventory: () => null, self: () => entry });
		const snap = await health.tick();
		assert.equal(snap.inventory, null);
		assert.deepEqual(snap.self, entry);
	});

	it("lists the hosts and wolves the hub reports: a local workerd stands in for its host's hub link, the hub's wolves join or enrich it, the rest show hub-only without actions", async () => {
		const hubHosts = [
			{ id: "sfo", label: "sfo-01", presence: "online", wolves: [{ name: "ada", status: "online" }, { name: "hal", status: "online" }] },
			{ id: "lap", label: "Mac", presence: "asleep", since: iso(T0 - 600_000), wolves: [{ name: "lappy", status: "offline" }] },
			{ id: "cron", presence: "offline", since: iso(T0 - 60_000), wolves: [{ name: "job", status: "offline" }] },
		];
		let hub: Record<string, unknown> | "refused" = { ok: true, service: "hubd", host: "sfo-01", hosts: hubHosts };
		const fakeFetch = (async (url: string) => {
			if (url === "http://127.0.0.1:3150/healthz") {
				if (hub === "refused") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
				return new Response(JSON.stringify(hub));
			}
			return new Response(JSON.stringify({ ok: true, service: "workerd", host: "sfo-01", hubHostId: "sfo", wolves: [{ name: "hal", state: "online" }] }));
		}) as unknown as typeof fetch;
		let t = T0;
		const health = createPackHealth({ targets: healthTargets({ WOLFPACK_HEALTH_WORKERDS: "workerd=http://127.0.0.1:7141" }), fetch: fakeFetch, now: () => t, consoleHost: "sfo-01", platform: "linux", log: () => {} });
		const view = (s: HealthSnapshot) =>
			Object.fromEntries(s.links.map((l) => [l.id, [l.host, l.status, l.error, l.via ?? null, l.source ?? null, l.restartable]]));
		const snap = await health.tick();
		assert.deepEqual(view(snap), {
			hubd: ["sfo-01", "ok", null, null, null, true],
			workerd: ["sfo-01", "ok", null, null, null, true],
			"wolfd@hal": ["sfo-01", "ok", null, "workerd", null, true],
			"wolfd@ada": ["sfo-01", "ok", null, "workerd", "hub", false],
			"hub-link@lap": ["mac", "unknown", "host_asleep", null, "hub", false],
			"wolfd@lappy": ["mac", "unknown", "host_asleep", "hub-link@lap", "hub", false],
			"hub-link@cron": ["cron", "down", "host_offline", null, "hub", false],
			"wolfd@job": ["cron", "down", "wolf_offline", "hub-link@cron", "hub", false],
		});
		assert.equal(linkOf(snap, "workerd").hubPresence, "online");
		assert.equal(linkOf(snap, "wolfd@hal").hubStatus, "online");
		assert.equal(linkOf(snap, "hub-link@lap").since, iso(T0 - 600_000));
		assert.deepEqual(snap.hosts.find((h) => h.id === "mac"), { id: "mac", label: "Mac", isThisConsole: false, hubId: "lap" });
		assert.deepEqual([...health.restartable()].sort(), ["hubd", "wolfd@hal", "workerd"]); // hub-only rows are never a restart target
		// The hub stops answering: its last list stays, graded unknown and dated; the local checks stay live.
		hub = "refused";
		t = T0 + 30_000;
		const stale = await health.tick();
		assert.deepEqual([linkOf(stale, "hub-link@cron").status, linkOf(stale, "hub-link@cron").error, linkOf(stale, "hub-link@cron").hubSeenAt], ["unknown", "hub_stale", iso(T0)]);
		assert.deepEqual([linkOf(stale, "wolfd@ada").status, linkOf(stale, "wolfd@ada").error], ["unknown", "hub_stale"]);
		assert.deepEqual([linkOf(stale, "wolfd@hal").status, linkOf(stale, "hubd").status], ["ok", "down"]);
		// An older hub that answers without `hosts`: back to the local checks only.
		hub = { ok: true, service: "hubd" };
		const old = await health.tick();
		assert.deepEqual(old.links.map((l) => l.id).sort(), ["hubd", "wolfd@hal", "workerd"]);
	});

	it("shows an older workerd's machine once: the hub host whose label is that workerd's host joins its card; a free-text label is ignored", async () => {
		const fakeFetch = (async (url: string) => {
			if (url === "http://127.0.0.1:3150/healthz") {
				return new Response(JSON.stringify({ ok: true, service: "hubd", hosts: [
					{ id: "sfo", label: "sfo-01", presence: "online", wolves: [{ name: "hal", status: "online" }] },
					{ id: "cron", label: "Ada Lovelace", presence: "offline", wolves: [] },
				] }));
			}
			return new Response(JSON.stringify({ ok: true, service: "workerd", host: "sfo-01", wolves: [{ name: "hal", state: "online" }] })); // an older build: no hubHostId
		}) as unknown as typeof fetch;
		const health = createPackHealth({ targets: healthTargets({ WOLFPACK_HEALTH_WORKERDS: "workerd=http://127.0.0.1:7141" }), fetch: fakeFetch, now: () => T0, consoleHost: "luka-air", platform: "darwin", log: () => {} });
		const snap = await health.tick();
		assert.deepEqual(snap.links.map((l) => l.id).sort(), ["hub-link@cron", "hubd", "wolfd@hal", "workerd"]); // no hub-link@sfo: the workerd is that host
		assert.equal(linkOf(snap, "workerd").hubPresence, "online");
		assert.equal(linkOf(snap, "hub-link@cron").host, "cron"); // not "ada-lovelace"
	});

	it("groups by the machine services report: hubd, workerd-wolves (host id sfo-01-wolves) and its wolf share the machine sfo-01 whatever their hostnames; a hub-only host uses its machine over its label", async () => {
		const fakeFetch = (async (url: string) => {
			if (url === "http://127.0.0.1:3150/healthz") {
				return new Response(JSON.stringify({ ok: true, service: "hubd", host: "ip-10-0-0-5", machine: "sfo-01", hosts: [
					{ id: "sfo-01-wolves", label: "ip-10-0-0-5", machine: "sfo-01", presence: "online", wolves: [{ name: "hal", status: "online" }] },
					{ id: "ci", label: "ci-runner", machine: "Build-Box", presence: "offline", wolves: [] },
				] }));
			}
			return new Response(JSON.stringify({ ok: true, service: "workerd", host: "ip-10-0-0-5", machine: "sfo-01", hubHostId: "sfo-01-wolves", wolves: [{ name: "hal", state: "online" }] }));
		}) as unknown as typeof fetch;
		const health = createPackHealth({ targets: healthTargets({ WOLFPACK_HEALTH_WORKERDS: "workerd-wolves=http://127.0.0.1:7141" }), fetch: fakeFetch, now: () => T0, consoleHost: "luka-air", platform: "darwin", log: () => {} });
		const snap = await health.tick();
		for (const id of ["hubd", "workerd-wolves", "wolfd@hal"]) assert.equal(linkOf(snap, id).host, "sfo-01", id);
		assert.equal(linkOf(snap, "hub-link@ci").host, "build-box");
		assert.deepEqual(snap.hosts?.filter((h) => h.isThisConsole).map((h) => h.id), ["luka-air"]);
	});

	it("puts the same worker in one group by the local and the hub path whatever the case or .local; an invalid machine name falls back to the hostname", async () => {
		const fakeFetch = (async (url: string) => {
			if (url === "http://127.0.0.1:3150/healthz") {
				return new Response(JSON.stringify({ ok: true, service: "hubd", hosts: [
					{ id: "ci", label: "ci-runner", machine: "Build-Box.local", presence: "online", wolves: [] },
					{ id: "odd", label: "odd-host", machine: "my_box", presence: "offline", wolves: [] },
				] }));
			}
			return new Response(JSON.stringify({ ok: true, service: "workerd", host: "Other-Host", machine: "my_box", wolves: [] }));
		}) as unknown as typeof fetch;
		const health = createPackHealth({ targets: healthTargets({ WOLFPACK_HEALTH_WORKERDS: "workerd=http://127.0.0.1:7141" }), fetch: fakeFetch, now: () => T0, consoleHost: "luka-air", platform: "darwin", log: () => {} });
		const snap = await health.tick();
		assert.equal(linkOf(snap, "hub-link@ci").host, "build-box"); // hub path: .local and case dropped
		assert.equal(linkOf(snap, "hub-link@odd").host, "odd-host"); // invalid machine: the label, as before
		assert.equal(linkOf(snap, "workerd").host, "other-host"); // local path: invalid machine, hostname
	});

	it("reports a refused hub as down and a hanging hub as frozen, keeping lastOkAt, without calling the hub's API", async () => {
		const s = await setup();
		await s.tick(T0);
		const ok = await s.get();
		assert.equal(linkOf(ok, "hubd").status, "ok");
		assert.equal(linkOf(ok, "hubd").lastOkAt, iso(T0));
		assert.equal(linkOf(ok, "hubd").version, "1.2.3");

		await s.hub.refuse();
		const down = await s.tick(T0 + 5000);
		assert.equal(linkOf(down, "hubd").status, "down");
		assert.equal(linkOf(down, "hubd").lastOkAt, iso(T0));
		assert.equal(linkOf(down, "hubd").lastCheckedAt, iso(T0 + 5000));

		await s.hub.back();
		s.hub.set("hang");
		const frozen = await s.tick(T0 + 10_000);
		const h = linkOf(frozen, "hubd");
		assert.equal(h.status, "frozen");
		assert.equal(h.lastOkAt, iso(T0));
		assert.ok(h.responseMs !== null && h.responseMs >= 300, `responseMs ${h.responseMs}`);
		assert.equal(linkOf(frozen, "workerd").status, "ok"); // the other links are unaffected

		assert.deepEqual(new Set(s.hub.seen.map((r) => r.path)), new Set(["/healthz"]));
		assert.equal(s.hub.seen.some((r) => r.auth !== undefined), false);
	});

	it("an older build without /healthz (401, a non-health 200, a body with no service) is unknown, not down; another service is down", async () => {
		const s = await setup();
		await s.tick(T0);
		const seen: [string, string | null, string | null][] = [];
		for (const [i, m] of (["http401", "bad-body", "legacy", "wrong-service"] as const).entries()) {
			s.hub.set(m);
			const h = linkOf(await s.tick(T0 + (i + 1) * 5000), "hubd");
			seen.push([h.status, h.error, h.lastOkAt]);
		}
		assert.deepEqual(seen, [
			["unknown", "no_healthz", iso(T0)],
			["unknown", "no_healthz", iso(T0)],
			["unknown", "no_healthz", iso(T0)],
			["down", "wrong_service", iso(T0)],
		]);
	});

	it("names each failure by a short code (no raw error text, paths or addresses in the unauthenticated snapshot)", async () => {
		const s = await setup({ wolves: () => [{ name: "hal", state: "failed: /home/wolf-hal/den", restarts: 3 }] });
		const codes: (string | null)[] = [];
		const all: (string | null)[] = [];
		const round = async (at: number) => {
			const snap = await s.tick(at);
			codes.push(linkOf(snap, "hubd").error);
			all.push(...snap.links.map((l) => l.error));
		};
		for (const [i, m] of (["hang", "http500", "wrong-service", "http401"] as const).entries()) {
			s.hub.set(m);
			await round(T0 + i * 5000);
		}
		await s.hub.refuse();
		await s.tick(T0 + 20_000); // the pooled keep-alive socket is reset first; the next probe meets a closed port
		await round(T0 + 25_000);
		assert.deepEqual(codes, ["timeout", "http_500", "wrong_service", "no_healthz", "refused"]);
		const leaky = all.filter((e) => e !== null && /[:/]/.test(e));
		assert.deepEqual(leaky, []);
	});

	it("records the history ok -> down -> restarting -> recovering -> ok with timestamps across a restart", async () => {
		const s = await setup();
		s.witness.verified("tok");
		await s.tick(T0);
		await s.hub.refuse();
		await s.tick(T0 + 5000);
		await s.hub.back(); // the old process still answers until systemd replaces it
		s.clock.set(T0 + 6000);
		const r = await s.api.restart(new Request("http://c/api/health/restart", { method: "POST", headers: { authorization: "Bearer tok" }, body: JSON.stringify({ service: "hubd" }) }));
		assert.equal(r.status, 202);
		assert.equal(linkOf(await s.tick(T0 + 8000), "hubd").status, "restarting"); // answering, but uptime 1000 s: not the new process
		s.hub.setUptime(3);
		s.hub.set("slow-lag"); // the new process: fast answer, lag window still full of its startup stall
		assert.equal(linkOf(await s.tick(T0 + 9000), "hubd").status, "recovering");
		s.hub.set("ok");
		const back = linkOf(await s.tick(T0 + 14_000), "hubd");
		assert.deepEqual(back.history, [
			{ status: "ok", at: iso(T0) },
			{ status: "down", at: iso(T0 + 5000) },
			{ status: "restarting", at: iso(T0 + 6000) },
			{ status: "recovering", at: iso(T0 + 9000) },
			{ status: "ok", at: iso(T0 + 14_000) },
		]);
		assert.deepEqual(back.lastRestart, { at: iso(T0 + 6000), ok: true });
	});
});

describe("pack health: SSE and the session file", () => {
	it("a stream whose client already left ends at once; one that leaves later ends after its first frame", async () => {
		const s = await setup();
		await s.tick(T0);
		const within = (p: Promise<string>) => Promise.race([p, new Promise<string>((_, rej) => setTimeout(() => rej(new Error("stream still open")), 1000).unref())]);
		const gone = new AbortController();
		gone.abort();
		assert.equal(await within(s.api.stream(gone.signal).text()), "");
		const later = new AbortController();
		const text = within(s.api.stream(later.signal).text());
		later.abort();
		assert.match(await text, /^data: \{"checkedAt":"2026-11-08T10:00:00.000Z"/);
	});

	it("persists verified tokens to a 0600 file another console process reloads, dropping entries older than 72 h", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "witness-"));
		cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
		const file = path.join(dir, "health-sessions.json");
		let t = T0;
		const w = createSessionWitness({ file, now: () => t });
		w.verified("old");
		t = T0 + 1000;
		w.verified("new"); // a new token is written even inside the refresh throttle
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		assert.deepEqual(fs.readdirSync(dir), ["health-sessions.json"]);
		const back = createSessionWitness({ file, now: () => T0 + 1000 });
		assert.deepEqual([back.isRecent("old"), back.isRecent("new"), back.isRecent("other")], [true, true, false]);
		const late = createSessionWitness({ file, now: () => T0 + 72 * 3600_000 + 500 });
		assert.deepEqual([late.isRecent("old"), late.isRecent("new")], [false, true]);
	});
});

describe("pack health: wolves read off workerd", () => {
	it("a restarted wolf stays restarting while workerd still reports the old process online; ends when its restart count goes up", async () => {
		let wolf = { name: "hal", state: "online", restarts: 2 };
		const s = await setup({ wolves: () => [wolf] });
		s.witness.verified("tok");
		await s.tick(T0);
		s.clock.set(T0 + 1000);
		assert.equal((await s.api.restart(restartReq("wolfd@hal", "tok"))).status, 202);
		assert.equal(linkOf(await s.tick(T0 + 5000), "wolfd@hal").status, "restarting"); // still the old process: same count, never went out
		assert.equal(linkOf(await s.tick(T0 + 10_000), "wolfd@hal").status, "restarting");
		wolf = { name: "hal", state: "online", restarts: 3 };
		const back = linkOf(await s.tick(T0 + 15_000), "wolfd@hal");
		assert.equal(back.status, "ok");
		assert.deepEqual(back.history.map((h) => h.status), ["ok", "restarting", "ok"]);
	});

	it("a restarted wolf seen out then online again ends restarting; one never seen out ends at the 120 s deadline", async () => {
		const states: Record<string, string> = { hal: "online", ada: "online" };
		const s = await setup({ wolves: () => Object.entries(states).map(([name, state]) => ({ name, state, restarts: 0 })) });
		s.witness.verified("tok");
		await s.tick(T0);
		for (const w of ["wolfd@hal", "wolfd@ada"]) assert.equal((await s.api.restart(restartReq(w, "tok"))).status, 202);
		states.hal = "stopped";
		await s.tick(T0 + 5000);
		states.hal = "online";
		const mid = await s.tick(T0 + 10_000);
		assert.equal(linkOf(mid, "wolfd@hal").status, "ok");
		assert.equal(linkOf(mid, "wolfd@ada").status, "restarting");
		assert.equal(linkOf(await s.tick(T0 + 119_000), "wolfd@ada").status, "restarting");
		assert.equal(linkOf(await s.tick(T0 + 121_000), "wolfd@ada").status, "ok");
	});

	it("reads at most 64 wolves per workerd and drops a wolf no workerd reported for over 10 minutes", async () => {
		let wolves: { name: string; state: string; restarts: number }[] = Array.from({ length: 70 }, (_, i) => ({ name: `w${i}`, state: "online", restarts: 0 }));
		const s = await setup({ wolves: () => wolves });
		const ids = (snap: HealthSnapshot) => snap.links.filter((l) => l.kind === "wolfd").map((l) => l.id);
		const first = await s.tick(T0);
		assert.equal(ids(first).length, 64);
		assert.equal(ids(first).includes("wolfd@w64"), false);
		wolves = [{ name: "w0", state: "online", restarts: 0 }];
		const gone = await s.tick(T0 + 5000);
		assert.equal(linkOf(gone, "wolfd@w1").status, "unknown");
		assert.equal(ids(await s.tick(T0 + 10 * 60_000)).length, 64); // last reported at T0: exactly 10 min, kept
		assert.deepEqual(ids(await s.tick(T0 + 10 * 60_000 + 1)), ["wolfd@w0"]);
	});

	it("keeps the wolves of a frozen workerd as unknown (workerd_unavailable); the 10 min prune counts only while that workerd answers", async () => {
		let wolves = [{ name: "hal", state: "online", restarts: 0 }];
		const s = await setup({ wolves: () => wolves });
		await s.tick(T0);
		s.workerd.set("hang");
		const frozen = linkOf(await s.tick(T0 + 15 * 60_000), "wolfd@hal");
		assert.deepEqual([frozen.status, frozen.error], ["unknown", "workerd_unavailable"]);
		s.workerd.set("ok");
		wolves = [];
		const left = linkOf(await s.tick(T0 + 16 * 60_000), "wolfd@hal");
		assert.deepEqual([left.status, left.error], ["unknown", "not_reported"]);
		assert.equal((await s.tick(T0 + 25 * 60_000)).links.some((l) => l.id === "wolfd@hal"), true);
		assert.equal((await s.tick(T0 + 25 * 60_000 + 1)).links.some((l) => l.id === "wolfd@hal"), false);
	});
});

const restartReq = (service: unknown, token?: string) =>
	new Request("http://c/api/health/restart", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ service }) });

describe("pack health: POST /api/health/restart", () => {
	it("restarts hubd, a workerd unit and a wolf the workerd reported via argv systemctl; rejects unknown and injected names before running anything", async () => {
		const s = await setup({ wolves: () => [{ name: "hal", state: "online", restarts: 0 }] });
		s.witness.verified("tok");
		const snap = await s.tick(T0);
		assert.equal(linkOf(snap, "wolfd@hal").status, "ok");
		assert.equal(linkOf(snap, "wolfd@hal").via, "workerd");
		for (const service of ["hubd", "workerd", "wolfd@hal"]) assert.equal((await s.api.restart(restartReq(service, "tok"))).status, 202, service);
		assert.deepEqual(s.runs, [
			["systemctl", "--no-ask-password", "--no-block", "restart", "hubd.service"],
			["systemctl", "--no-ask-password", "--no-block", "restart", "workerd.service"],
			["systemctl", "--no-ask-password", "--no-block", "restart", "wolfd@hal.service"],
		]);
		for (const bad of ["wolfd@ghost", "ssh", "hubd; rm -rf /", "wolfd@hal.service --now", "wolfd@../x", "", 7, null]) {
			const r = await s.api.restart(restartReq(bad, "tok"));
			assert.equal(r.status, 400, String(bad));
			assert.equal(((await r.json()) as { code: string }).code, "invalid_request");
		}
		assert.equal(s.runs.length, 3);
		assert.ok(s.logs.some((l) => /health restart hubd by device [0-9a-f]{12}: ok/.test(l)), s.logs.join("\n"));
	});

	it("answers 501 unsupported off systemd (the Mac) and runs no systemctl", async () => {
		const s = await setup({ systemd: false });
		s.witness.verified("tok");
		await s.tick(T0);
		const r = await s.api.restart(restartReq("hubd", "tok"));
		assert.equal(r.status, 501);
		assert.equal(((await r.json()) as { code: string }).code, "unsupported");
		assert.deepEqual(s.runs, []);
	});

	it("allows one restart per service per minute (429 + Retry-After), other services unaffected", async () => {
		const s = await setup();
		s.witness.verified("tok");
		await s.tick(T0);
		assert.equal((await s.api.restart(restartReq("hubd", "tok"))).status, 202);
		s.clock.set(T0 + 20_000);
		const limited = await s.api.restart(restartReq("hubd", "tok"));
		assert.equal(limited.status, 429);
		assert.equal(limited.headers.get("retry-after"), "40");
		assert.equal((await s.api.restart(restartReq("workerd", "tok"))).status, 202);
		s.clock.set(T0 + 60_000);
		assert.equal((await s.api.restart(restartReq("hubd", "tok"))).status, 202);
		assert.equal(s.runs.filter((r) => r[4] === "hubd.service").length, 2);
	});

	it("needs a device bearer the hub accepted (works with the hub down); none, unknown or hub-rejected tokens get 401 and run nothing", async () => {
		const s = await setup();
		await s.tick(T0);
		await s.hub.refuse();
		assert.equal((await s.api.restart(restartReq("hubd"))).status, 401);
		assert.equal((await s.api.restart(restartReq("hubd", "never-seen"))).status, 401);
		s.witness.verified("revoked");
		s.witness.rejected("revoked");
		assert.equal((await s.api.restart(restartReq("hubd", "revoked"))).status, 401);
		assert.deepEqual(s.runs, []);
		s.witness.verified("tok");
		assert.equal((await s.api.restart(restartReq("hubd", "tok"))).status, 202);
		assert.equal(s.hub.seen.some((r) => r.path !== "/healthz"), false);
		// the witness holds a token for 72 h after the hub last accepted it
		s.witness.verified("tok2");
		s.clock.set(T0 + 72 * 3600_000);
		assert.equal((await s.api.restart(restartReq("workerd", "tok2"))).status, 202);
		s.clock.set(T0 + 72 * 3600_000 + 1);
		assert.equal((await s.api.restart(restartReq("hubd", "tok2"))).status, 401);
	});

	it("while the hub is up it decides live: a token it revoked is refused at once and forgotten; a token it accepts needs no witness", async () => {
		const s = await setup();
		s.witness.verified("tok");
		await s.tick(T0);
		s.hub.revoked.add("tok");
		assert.equal((await s.api.restart(restartReq("hubd", "tok"))).status, 401);
		assert.deepEqual(s.runs, []);
		assert.equal((await s.api.restart(restartReq("workerd", "fresh"))).status, 202);
		assert.deepEqual(s.hub.seen.filter((r) => r.path !== "/healthz").map((r) => `${r.path} ${r.auth}`), ["/v1/wolves Bearer tok", "/v1/wolves Bearer fresh"]);
		await s.hub.refuse();
		await s.tick(T0 + 5000);
		assert.equal((await s.api.restart(restartReq("hubd", "tok"))).status, 401); // the hub is down now, and the witness forgot it
		assert.equal((await s.api.restart(restartReq("hubd", "fresh"))).status, 202); // accepted live earlier, so witnessed
	});

	it("a burst of restart POSTs with random bearers reaches the hub at most 2 at a time and 30 times a minute (429 + Retry-After beyond)", async () => {
		const s = await setup();
		await s.tick(T0);
		const apiCalls = () => s.hub.seen.filter((r) => r.path !== "/healthz").length;
		s.hub.set("hang"); // every live check stays in flight until its timeout
		const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => s.api.restart(restartReq("hubd", `rand-${i}`))));
		assert.equal(apiCalls(), 2);
		const limited = burst.filter((r) => r.status === 429);
		assert.equal(limited.length, 8);
		assert.deepEqual(new Set(limited.map((r) => r.headers.get("retry-after"))), new Set(["5"]));
		s.hub.set("ok");
		const statuses: number[] = [];
		for (let i = 10; i < 50; i++) {
			s.hub.revoked.add(`rand-${i}`);
			statuses.push((await s.api.restart(restartReq("hubd", `rand-${i}`))).status);
		}
		assert.equal(apiCalls(), 30);
		assert.deepEqual([statuses.filter((c) => c === 401).length, statuses.filter((c) => c === 429).length], [28, 12]);
		assert.deepEqual(s.runs, []);
		s.clock.set(T0 + 60_001);
		assert.equal((await s.api.restart(restartReq("hubd", "rand-x"))).status, 202); // the window moved on
		assert.equal(apiCalls(), 31);
	});

	it("a browser token the hub accepts through the console may restart; once the hub answers 401 for it, it may not", async () => {
		let accept = true;
		const hub = createServer((_req, res) => {
			res.setHeader("Content-Type", "application/json");
			if (!accept) {
				res.statusCode = 401;
				return res.end(JSON.stringify({ code: "unauthorized", message: "revoked", retryable: false }));
			}
			res.end(JSON.stringify({ wolves: [], threads: [] }));
		});
		await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
		cleanups.push(() => new Promise<void>((r) => { hub.closeAllConnections(); hub.close(() => r()); }));
		const url = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
		const s = await setup();
		setSessionWitness(s.witness);
		try {
			await s.tick(T0);
			await s.hub.refuse(); // pack health's hubd is down: only the witness can authorise
			await s.tick(T0 + 5000);
			const client = createConsoleClient({ WOLFPACK_HUB_URL: url, WOLFPACK_HUB_RELAY: "1" }, makeRequestToken(async () => new Headers({ authorization: "Bearer phone-tok" })));
			assert.equal((await s.api.restart(restartReq("hubd", "phone-tok"))).status, 401);
			await client.listWolves();
			assert.equal((await s.api.restart(restartReq("hubd", "phone-tok"))).status, 202);
			accept = false;
			await assert.rejects(client.listWolves());
			assert.equal((await s.api.restart(restartReq("workerd", "phone-tok"))).status, 401);
		} finally {
			setSessionWitness(undefined);
		}
	});
});

const rollbackReq = (service: unknown, token?: string) =>
	new Request("http://c/api/health/rollback", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ service }) });

/** An /opt with hubd at 0.1.14+abc keeping 0.1.13 as previous (swapped with `previousNewer`), and a workerd install with nothing kept. */
function optWithHubdPrevious(o: { previousNewer?: boolean } = {}): string {
	const opt = fs.mkdtempSync(path.join(os.tmpdir(), "rollback-opt-"));
	cleanups.push(async () => fs.rmSync(opt, { recursive: true, force: true }));
	const hubd = path.join(opt, "wolfpack-hubd");
	for (const [rel, ver] of [["r1", "0.1.13"], ["r2", "0.1.14+abc"]] as const) {
		fs.mkdirSync(path.join(hubd, "releases", rel), { recursive: true });
		fs.writeFileSync(path.join(hubd, "releases", rel, "VERSION"), `${ver}\n`);
	}
	const [cur, prev] = o.previousNewer ? ["r1", "r2"] : ["r2", "r1"];
	fs.symlinkSync(path.join(hubd, "releases", cur), path.join(hubd, "current"));
	fs.symlinkSync(path.join(hubd, "releases", prev), path.join(hubd, "previous"));
	fs.mkdirSync(path.join(opt, "wolfpack-workerd", "releases", "only"), { recursive: true }); // installed, nothing kept to go back to
	fs.symlinkSync(path.join(opt, "wolfpack-workerd", "releases", "only"), path.join(opt, "wolfpack-workerd", "current"));
	return opt;
}

describe("pack health: POST /api/health/rollback", () => {
	it("starts the rollback unit for a service with a kept previous release, names the version it goes back to, and allows one per service per 10 min", async () => {
		const opt = optWithHubdPrevious();
		const s = await setup({ optRoot: opt, wolves: () => [{ name: "hal", state: "online", restarts: 0 }] });
		await s.tick(T0);
		assert.deepEqual((await s.get()).actions.rollback, [{ service: "hubd", from: "0.1.14+abc", to: "0.1.13", last: null }]);
		assert.equal((await s.api.rollback(rollbackReq("hubd"))).status, 401);
		s.witness.verified("tok");
		for (const bad of ["wolfd@hal", "ssh", "hubd; rm -rf /", "hubd --now", "", null]) {
			const r = await s.api.rollback(rollbackReq(bad, "tok"));
			assert.equal(r.status, 400, String(bad));
		}
		const none = await s.api.rollback(rollbackReq("workerd", "tok"));
		assert.equal(none.status, 409);
		assert.equal(((await none.json()) as { code: string }).code, "no_previous");
		assert.deepEqual(s.runs, []);

		const ok = await s.api.rollback(rollbackReq("hubd", "tok"));
		assert.equal(ok.status, 202);
		assert.equal(((await ok.json()) as { to: string }).to, "0.1.13");
		assert.deepEqual(s.runs, [["systemctl", "--no-ask-password", "--no-block", "start", "wolfpack-rollback@hubd.service"]]);
		s.clock.set(T0 + 4 * 60_000);
		const limited = await s.api.rollback(rollbackReq("hubd", "tok"));
		assert.equal(limited.status, 429);
		assert.equal(limited.headers.get("retry-after"), "360");
		s.clock.set(T0 + 10 * 60_000);
		assert.equal((await s.api.rollback(rollbackReq("hubd", "tok"))).status, 202);
		assert.equal(s.runs.length, 2);
	});

	it("refuses with 409 previous_is_newer when the kept release is newer than the running one, without calling systemctl", async () => {
		const s = await setup({ optRoot: optWithHubdPrevious({ previousNewer: true }) });
		await s.tick(T0);
		s.witness.verified("tok");
		const r = await s.api.rollback(rollbackReq("hubd", "tok"));
		assert.equal(r.status, 409);
		assert.equal(((await r.json()) as { code: string }).code, "previous_is_newer");
		assert.deepEqual(s.runs, []);
	});

	it("a rollback systemctl refuses (502) does not use up the service's 10 min slot", async () => {
		const s = await setup({ optRoot: optWithHubdPrevious() });
		await s.tick(T0);
		s.witness.verified("tok");
		s.setExit(1);
		assert.equal((await s.api.rollback(rollbackReq("hubd", "tok"))).status, 502);
		s.setExit(0);
		assert.equal((await s.api.rollback(rollbackReq("hubd", "tok"))).status, 202);
	});

	it("reports each rollback unit's last result from systemctl show (argv, cached): a failure with its exit status and time, running while active, null before it ever ran", async () => {
		const s = await setup({ optRoot: optWithHubdPrevious() });
		await s.tick(T0);
		const lastOf = async () => (await s.get()).actions.rollback.find((r) => r.service === "hubd")?.last;
		s.setShow("wolfpack-rollback@hubd.service", "ActiveState=inactive\nResult=success\nExecMainStatus=0\nExecMainExitTimestamp=\n");
		await s.releases.refresh();
		assert.equal(await lastOf(), null);
		assert.deepEqual(s.shows, [["systemctl", "show", "wolfpack-rollback@hubd.service", "-p", "Result,ExecMainStatus,ActiveState,ExecMainExitTimestamp,AssertResult,AssertTimestamp", "--timestamp=unix"]]);

		s.setShow("wolfpack-rollback@hubd.service", "Result=exit-code\nExecMainStatus=4\nActiveState=failed\nExecMainExitTimestamp=@1794218400\n");
		await s.releases.refresh();
		assert.equal(await lastOf(), null, "read again only after the cache time");
		assert.equal(s.shows.length, 1);
		s.clock.set(T0 + 5_000);
		await s.releases.refresh();
		assert.deepEqual(await lastOf(), { result: "exit-code", exitStatus: 4, at: "2026-11-09T10:00:00.000Z" });

		s.setShow("wolfpack-rollback@hubd.service", "Result=success\nExecMainStatus=0\nActiveState=activating\nExecMainExitTimestamp=@1794218400\n");
		s.clock.set(T0 + 10_000);
		await s.releases.refresh();
		assert.deepEqual(await lastOf(), { result: "running", exitStatus: null, at: null });
	});

	it("reports a start refused by the unit's assert (nothing ran, the exit time did not move) as a new assert failure at the assert time", async () => {
		const s = await setup({ optRoot: optWithHubdPrevious() });
		const lastOf = async () => (await s.get()).actions.rollback.find((r) => r.service === "hubd")?.last;
		const old = "ActiveState=inactive\nResult=success\nExecMainStatus=0\nExecMainExitTimestamp=@1794218400\n";
		s.setShow("wolfpack-rollback@hubd.service", `${old}AssertResult=yes\nAssertTimestamp=@1794218390\n`);
		await s.tick(T0);
		await s.releases.refresh();
		assert.deepEqual(await lastOf(), { result: "success", exitStatus: 0, at: "2026-11-09T10:00:00.000Z" });

		// systemd on a failed AssertPathExists: only AssertResult/AssertTimestamp change; Result, ActiveState and the exec times stay.
		s.setShow("wolfpack-rollback@hubd.service", `${old}AssertResult=no\nAssertTimestamp=@1794222000\n`);
		s.clock.set(T0 + 5_000);
		await s.releases.refresh();
		assert.deepEqual(await lastOf(), { result: "assert", exitStatus: null, at: "2026-11-09T11:00:00.000Z" });
	});
});

const updateReq = (token?: string, component?: unknown) =>
	new Request("http://c/api/health/update", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(component === undefined ? {} : { component }) });
const UPDATE_UNIT = "wolfpack-auto-update-now.service";
const PENDING: UpdateUnit[] = [{ component: "hubd", from: "0.1.14", to: "0.1.15" }, { component: "console", from: "0.1.18", to: "0.1.19" }];

describe("pack health: POST /api/health/update", () => {
	it("needs a verified device; starts exactly the manual auto-update unit (argv, no shell) naming the units that will update", async () => {
		const s = await setup();
		await s.tick(T0);
		s.setPending(PENDING);
		assert.equal((await s.api.update(updateReq())).status, 401);
		assert.deepEqual(s.runs, []);
		s.witness.verified("tok");
		const ok = await s.api.update(updateReq("tok"));
		assert.equal(ok.status, 202);
		assert.deepEqual(((await ok.json()) as { units: UpdateUnit[] }).units, PENDING);
		assert.deepEqual(s.runs, [["systemctl", "--no-ask-password", "--no-block", "start", UPDATE_UNIT]]);
	});

	it("updates one component through its own template unit: 400 for an unknown name, 409 up_to_date when it is current, and 409 running while any update unit is still activating", async () => {
		const s = await setup();
		await s.tick(T0);
		s.setPending(PENDING);
		s.witness.verified("tok");
		const bad = await s.api.update(updateReq("tok", "nope"));
		assert.equal(bad.status, 400);
		const cur = await s.api.update(updateReq("tok", "workerd"));
		assert.equal(cur.status, 409);
		assert.equal(((await cur.json()) as { code: string }).code, "up_to_date");
		assert.deepEqual(s.runs, []);
		const ok = await s.api.update(updateReq("tok", "hubd"));
		assert.equal(ok.status, 202);
		assert.deepEqual(((await ok.json()) as { units: UpdateUnit[] }).units, [PENDING[0]]);
		assert.deepEqual(s.runs, [["systemctl", "--no-ask-password", "--no-block", "start", "wolfpack-auto-update-now@hubd.service"]]);
		s.setShow(UPDATE_UNIT, "ActiveState=activating\nResult=success\nExecMainStatus=0\n");
		const busy = await s.api.update(updateReq("tok", "console"));
		assert.equal(busy.status, 409);
		assert.equal(((await busy.json()) as { code: string }).code, "running");
		assert.equal(s.runs.length, 1);
	});

	it("refuses with 409 when nothing is behind, or while the unit is still activating, without starting it", async () => {
		const s = await setup();
		await s.tick(T0);
		s.witness.verified("tok");
		const none = await s.api.update(updateReq("tok"));
		assert.equal(none.status, 409);
		assert.equal(((await none.json()) as { code: string }).code, "no_update");
		s.setPending(PENDING);
		s.setShow(UPDATE_UNIT, "ActiveState=activating\nResult=success\nExecMainStatus=0\n");
		const busy = await s.api.update(updateReq("tok"));
		assert.equal(busy.status, 409);
		assert.equal(((await busy.json()) as { code: string }).code, "running");
		assert.deepEqual(s.runs, []);
	});

	it("two concurrent presses start the unit once; the second is told an update is already running", async () => {
		const s = await setup();
		await s.tick(T0);
		s.setPending(PENDING);
		// At the updater itself: through the API the bearer check staggers the two requests.
		const [a, b] = await Promise.all([s.updater.update("a"), s.updater.update("b")]);
		assert.deepEqual([a.ok, b.ok], [true, false]);
		assert.equal(b.ok === false && b.code, "running");
		assert.equal(s.runs.length, 1);
	});

	it("GET shows only component names, versions and the last run's {result, exitStatus, at}, and answers anonymous polling from a 2 s cache", async () => {
		const s = await setup();
		s.setPending(PENDING);
		s.setShow(UPDATE_UNIT, "Result=exit-code\nExecMainStatus=3\nActiveState=failed\nExecMainExitTimestamp=@1794218400\nInvocationID=secret\n");
		const first = await (await s.api.updateState()).json();
		assert.deepEqual(first, {
			units: PENDING,
			last: { result: "exit-code", exitStatus: 3, at: "2026-11-09T10:00:00.000Z" },
		});
		const [b, c] = await Promise.all([s.api.updateState(), s.api.updateState()]);
		assert.deepEqual(await b.json(), first);
		assert.deepEqual(await c.json(), first);
		assert.equal(s.availableCalls.n, 1);
		s.clock.set(T0 + 2_500);
		await s.api.updateState();
		assert.equal(s.availableCalls.n, 2);
	});

	it("a start systemctl refuses answers 502 and the next press can start it", async () => {
		const s = await setup();
		await s.tick(T0);
		s.setPending(PENDING);
		s.witness.verified("tok");
		s.setExit(1);
		assert.equal((await s.api.update(updateReq("tok"))).status, 502);
		s.setExit(0);
		assert.equal((await s.api.update(updateReq("tok"))).status, 202);
	});
});
