/**
 * Pack health (work-wolfpack-LUQ7C2B) at its seam: the /api/health handlers (createHealthApi) over a real monitor and restarter,
 * against real local HTTP servers that answer, hang (frozen) or refuse. The command runner is injected (no systemctl runs).
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { createHealthApi, hubTokenCheck } from "../src/server/health-api.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createPackHealth, createRestarter, healthTargets, hubTarget, type CommandRunner, type HealthSnapshot, type LinkSnapshot } from "../src/server/pack-health.ts";
import { createSessionWitness, setSessionWitness } from "../src/server/session-witness.ts";
import { createConsoleClient, makeRequestToken } from "../src/server/console-client.ts";

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

async function setup(o: { wolves?: () => unknown[] } = {}) {
	const hub = await fakeService("hubd");
	const workerd = await fakeService("workerd", () => ({ wolves: o.wolves?.() ?? [] }));
	cleanups.push(hub.close, workerd.close);
	let t = T0;
	const clock = { now: () => t, set: (ms: number) => { t = ms; } };
	const env = { WOLFPACK_HUB_URL: hub.url, WOLFPACK_HEALTH_WORKERDS: `workerd=${workerd.url}` };
	const health = createPackHealth({ targets: healthTargets(env), timeoutMs: 300, now: clock.now });
	const runs: string[][] = [];
	let exit = 0;
	const run: CommandRunner = async (file, args) => { runs.push([file, ...args]); return { code: exit, stderr: "" }; };
	const logs: string[] = [];
	const restarter = createRestarter({ health, run, now: clock.now, minIntervalMs: 60_000, log: (m) => logs.push(m) });
	const witness = createSessionWitness({ now: clock.now });
	const api = createHealthApi({ health, restarter, witness, checkToken: hubTokenCheck(hubTarget(env).wolvesUrl, { timeoutMs: 300 }), now: clock.now });
	const get = async () => (await (await api.get()).json()) as HealthSnapshot;
	const tick = async (at: number) => { clock.set(at); return health.tick(); };
	return { hub, workerd, clock, health, api, get, tick, runs, logs, witness, setExit: (c: number) => { exit = c; } };
}

describe("pack health: GET /api/health", () => {
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
