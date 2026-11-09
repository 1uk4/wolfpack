/**
 * The direct path to the local workerd (work-wolfpack-Fy45EOA) at its seams: the console client factory (createConsoleClient in relay
 * mode with a DirectRoute), the pack-health snapshot and directTarget, against a real local fake hub and a real local fake workerd that
 * checks the local token like workerd's /direct/v1 does.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createConsoleClient, makeRequestToken } from "../src/server/console-client.ts";
import { directRoute, directTarget } from "../src/server/direct-path.ts";
import { createPackHealth, healthTargets, type HealthSnapshot } from "../src/server/pack-health.ts";
import { createSessionWitness, setSessionWitness } from "../src/server/session-witness.ts";

const cleanups: (() => Promise<void> | void)[] = [];
after(async () => { for (const c of cleanups) await c(); });

async function listen(make: () => Server) {
	let srv = make();
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
	const port = (srv.address() as AddressInfo).port;
	const close = () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); });
	cleanups.push(close);
	return { url: `http://127.0.0.1:${port}`, close, back: async () => { srv = make(); await new Promise<void>((r) => srv.listen(port, "127.0.0.1", r)); } };
}

const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
};

const STREAM = "/threads/alpha%2Fhome/stream";
const ev = (id: number, type: string, wolf: string) => `id: ${id}\ndata: ${JSON.stringify({ id, threadId: "alpha/home", at: "2026-11-09T00:00:00Z", actor: { id: wolf, kind: "wolf" }, type, turnId: wolf, ...(type === "turn-end" ? { reason: "complete" } : {}) })}\n\n`;

/**
 * hubd: /healthz (counted; `healthDown` drops the connection), GET /v1/wolves for a bearer it accepts (401 for one in `revoked`;
 * `apiDown` drops every /v1 connection), and the alpha/home stream: "die-before" drops it at once, "one-then-die" sends one event,
 * then goes unhealthy and drops this and every later stream connection.
 */
async function fakeHub() {
	const st = { revoked: new Set<string>(), healthz: 0, healthDown: false, apiDown: false, stream: "ok" as "ok" | "die-before" | "one-then-die" | "dead" };
	const s = await listen(() => createServer((req, res) => {
		if (req.url === "/healthz") {
			st.healthz++;
			if (st.healthDown) return void req.socket.destroy();
			return json(res, 200, { ok: true, service: "hubd", version: "1", uptimeS: 100, lag: { p99Ms: 1, maxMs: 2 } });
		}
		if (st.apiDown) return void req.socket.destroy();
		const tok = (req.headers.authorization ?? "").replace(/^Bearer /, "");
		if (!tok || st.revoked.has(tok)) return json(res, 401, { code: "unauthorized", message: "revoked", retryable: false });
		if (req.url === `/v1${STREAM}`) {
			if (st.stream === "die-before" || st.stream === "dead") return void req.socket.destroy();
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.write(ev(1, "turn-start", "hub"));
			if (st.stream === "one-then-die") {
				st.stream = "dead";
				st.healthDown = true;
				setTimeout(() => req.socket.destroy(), 30);
			}
			return;
		}
		return json(res, 200, { wolves: [] });
	}));
	return { ...s, st };
}

/** workerd: /healthz, and /direct/v1/* only with the local token (401 otherwise); hosts the wolf `alpha` only. Records every direct path. */
async function fakeWorkerd(token: string) {
	const direct: string[] = [];
	const s = await listen(() => createServer((req, res) => {
		if (req.url === "/healthz") return json(res, 200, { ok: true, service: "workerd", version: "1", uptimeS: 100, lag: { p99Ms: 1, maxMs: 2 }, wolves: [] });
		if (!req.url?.startsWith("/direct/v1/")) return json(res, 404, { code: "not_found", message: "no such path", retryable: false });
		if (req.headers["x-wolfpack-direct-token"] !== token) return json(res, 401, { code: "unauthorized", message: "missing or wrong direct token", retryable: false });
		direct.push(req.url);
		if (req.url === "/direct/v1/wolves") return json(res, 200, { wolves: [{ id: "w-alpha", name: "alpha", host: "mac", status: "online" }] });
		if (req.url === "/direct/v1/wolves/alpha/threads") return json(res, 200, { threads: [{ id: "alpha/home", wolf: "alpha", kind: "home", title: "Home (local)" }] });
		if (req.url === `/direct/v1${STREAM}`) {
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			return res.end(ev(1, "turn-start", "local") + ev(2, "turn-end", "local") + "data: [DONE]\n\n");
		}
		return json(res, 404, { code: "not_found", message: "no such route here", retryable: false });
	}));
	return { ...s, direct };
}

async function setup(o: { fileToken?: string | null; sessionTtlMs?: number } = {}) {
	const hub = await fakeHub();
	const workerd = await fakeWorkerd("local-secret");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-direct-"));
	cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
	const tokenFile = path.join(dir, "direct-token");
	if (o.fileToken !== null) fs.writeFileSync(tokenFile, `${o.fileToken ?? "local-secret"}\n`, { mode: 0o600 });
	const env = { WOLFPACK_HUB_URL: hub.url, WOLFPACK_HUB_RELAY: "1", WOLFPACK_HEALTH_WORKERDS: `workerd=${workerd.url}`, WOLFPACK_WORKERD_DIRECT_URL: workerd.url, WOLFPACK_WORKERD_DIRECT_TOKEN_FILE: tokenFile };
	const health = createPackHealth({ targets: healthTargets(env), timeoutMs: 300, log: () => {} });
	let clock = Date.parse("2026-11-09T00:00:00Z");
	const witness = createSessionWitness({ now: () => clock });
	setSessionWitness(witness);
	cleanups.push(() => setSessionWitness(undefined));
	let bearer = "phone";
	const route = directRoute(health, directTarget(env)!, o.sessionTtlMs ? { sessionTtlMs: o.sessionTtlMs } : {});
	const client = createConsoleClient(env, makeRequestToken(async () => new Headers({ authorization: `Bearer ${bearer}` })), route);
	const directLink = (s: HealthSnapshot) => s.links.find((l) => l.id === "workerd-direct");
	/** hub verified the browser, then hubd stopped answering for one monitor round (the live check is the second). */
	const hubGoesDown = async () => {
		await health.tick();
		await client.listWolves();
		await hub.close();
		assert.equal((await health.tick()).route, "hub");
	};
	return { hub, workerd, health, client, directLink, hubGoesDown, setBearer: (b: string) => { bearer = b; }, advance: (ms: number) => { clock += ms; } };
}

const isRetryableUnavailable = (e: Error & { code?: string; retryable?: boolean }) => e.name === "ProtocolError" && e.code === "engine_error" && e.retryable === true && /hub is unreachable/.test(e.message);

describe("direct path to the local workerd", () => {
	it("after a failed monitor round, a call the hub does not answer runs a live round and is served by the local workerd", async () => {
		const s = await setup();
		await s.hubGoesDown();
		assert.deepEqual((await s.client.listWolves()).map((w) => w.name), ["alpha"]);
		const snap = s.health.snapshot();
		assert.deepEqual(
			[snap.route, snap.links.find((l) => l.id === "hubd")?.status, s.directLink(snap)?.status, s.directLink(snap)?.kind, s.directLink(snap)?.restartable],
			["direct", "down", "ok", "direct", false],
		);
		assert.deepEqual((await s.client.listThreads("alpha")).map((t) => t.title), ["Home (local)"]);
	});

	it("while direct, a wolf on another host is a retryable 'hub unreachable' error", async () => {
		const s = await setup();
		await s.hubGoesDown();
		await s.client.listWolves();
		await assert.rejects(s.client.listThreads("bravo"), isRetryableUnavailable);
	});

	it("while direct, hub-only routes and the excluded settings calls are retryable 'hub unreachable' errors and never reach the workerd", async () => {
		const s = await setup();
		await s.hubGoesDown();
		await s.client.listWolves();
		await assert.rejects(s.client.listWork!("alpha", { domain: "wolfpack" }), isRetryableUnavailable);
		await assert.rejects(s.client.putWolfSettings!("alpha", { model: "x" }, "etag"), isRetryableUnavailable);
		await assert.rejects(s.client.revealWolfSetting!("alpha", "env", "KEY"), isRetryableUnavailable);
		await assert.rejects(s.client.putPrompt!("alpha", "orchestrator-rules", "text", "etag"), isRetryableUnavailable);
		await assert.rejects(s.client.resetPrompt!("alpha", "orchestrator-rules", "etag"), isRetryableUnavailable);
		await assert.rejects(s.client.putThreadSettings!("alpha/home", { tier: "fast" }), isRetryableUnavailable);
		assert.deepEqual(s.workerd.direct.filter((p) => p !== "/direct/v1/wolves"), []);
	});

	it("an unverified browser is refused (401) on the direct path and its call never reaches the workerd", async () => {
		const s = await setup();
		await s.hubGoesDown();
		await s.client.listWolves();
		s.setBearer("stranger");
		await assert.rejects(s.client.listThreads("alpha"), (e: Error & { code?: string }) => e.code === "unauthorized");
		assert.ok(!s.workerd.direct.includes("/direct/v1/wolves/alpha/threads"), "the workerd saw the stranger's call");
	});

	it("the direct path needs a hub verification within 24 h (WOLFPACK_DIRECT_SESSION_TTL_H), not the 72 h of pack-health restarts", async () => {
		const s = await setup();
		await s.health.tick();
		await s.client.listWolves(); // the hub verifies "phone" now
		s.advance(25 * 3600_000);
		await s.hub.close();
		await s.health.tick();
		await assert.rejects(s.client.listThreads("alpha"), (e: Error & { code?: string }) => e.code === "unauthorized");
		assert.ok(!s.workerd.direct.includes("/direct/v1/wolves/alpha/threads"));
	});

	it("a hub that answers 401 keeps the route on the hub (no fallback)", async () => {
		const s = await setup();
		s.hub.st.revoked.add("phone");
		await s.health.tick();
		await assert.rejects(s.client.listThreads("alpha"), (e: Error & { code?: string }) => e.code === "unauthorized");
		assert.equal((await s.health.tick()).route, "hub");
		assert.ok(!s.workerd.direct.includes("/direct/v1/wolves/alpha/threads"));
	});

	it("a single failed hubd round between answering ones does not switch to direct", async () => {
		const s = await setup();
		await s.health.tick();
		s.hub.st.healthDown = true;
		assert.equal((await s.health.tick()).route, "hub");
		s.hub.st.healthDown = false;
		assert.equal((await s.health.tick()).route, "hub");
		s.hub.st.healthDown = true;
		assert.equal((await s.health.tick()).route, "hub");
		assert.equal((await s.health.tick()).route, "direct");
	});

	it("switches back to the hub only after 2 consecutive answering hubd rounds", async () => {
		const s = await setup();
		await s.hubGoesDown();
		assert.equal((await s.health.tick()).route, "direct");
		await s.hub.back();
		assert.equal((await s.health.tick()).route, "direct");
		assert.deepEqual((await s.client.listWolves()).map((w) => w.name), ["alpha"]);
		assert.equal((await s.health.tick()).route, "hub");
		assert.deepEqual(await s.client.listWolves(), []);
	});

	it("a burst of calls the hub drops runs at most one immediate monitor round per 2 s", async () => {
		const s = await setup();
		await s.health.tick();
		s.hub.st.apiDown = true; // hubd's /healthz answers, its API drops connections
		const before = s.hub.st.healthz;
		for (let i = 0; i < 20; i++) await assert.rejects(s.client.listWolves());
		assert.ok(s.hub.st.healthz - before <= 2, `${s.hub.st.healthz - before} hubd probes for 20 failing calls`);
	});

	it("a hub stream that fails before its first event falls back to the local workerd", async () => {
		const s = await setup();
		await s.hubGoesDown();
		await s.hub.back();
		s.hub.st.healthDown = true;
		s.hub.st.stream = "die-before";
		const types: string[] = [];
		for await (const e of s.client.watch("alpha/home")) types.push(`${e.type}:${e.actor?.id}`);
		assert.deepEqual(types, ["turn-start:local", "turn-end:local"]);
	});

	it("a hub stream that fails after its first event is not moved to the local workerd", async () => {
		const s = await setup();
		await s.health.tick();
		await s.client.listWolves();
		s.hub.st.stream = "one-then-die";
		const types: string[] = [];
		await assert.rejects(async () => {
			for await (const e of s.client.watch("alpha/home")) {
				types.push(`${e.type}:${e.actor?.id}`);
				if (types.length === 1) assert.equal((await s.health.tick()).route, "hub"); // one failed round: the live check would make it direct
			}
		}, (e: Error & { code?: string }) => e.code === "engine_error");
		assert.deepEqual(types, ["turn-start:hub"]);
		assert.ok(!s.workerd.direct.includes(`/direct/v1${STREAM}`), "the stream was moved to the workerd");
	});
});

describe("direct link in pack health", () => {
	it("probes the authenticated path: a wrong local token shows the link down (http_401) and the hub's outage stays on the hub", async () => {
		const s = await setup({ fileToken: "stale" });
		await s.health.tick();
		await s.hub.close();
		await s.health.tick();
		const snap = await s.health.tick();
		assert.deepEqual([s.directLink(snap)?.status, s.directLink(snap)?.error, snap.route], ["down", "http_401", "hub"]);
	});

	it("a missing token file shows the link down with no_token", async () => {
		const s = await setup({ fileToken: null });
		const snap = await s.health.tick();
		assert.deepEqual([s.directLink(snap)?.status, s.directLink(snap)?.error], ["down", "no_token"]);
	});
});

describe("directTarget", () => {
	it("accepts http on loopback only: https and non-loopback hosts turn the direct path off", () => {
		const t = (url: string) => directTarget({ WOLFPACK_WORKERD_DIRECT_URL: url, WOLFPACK_WORKERD_DIRECT_TOKEN_FILE: "/tmp/t" })?.url;
		assert.deepEqual(
			["http://127.0.0.1:7141", "http://[::1]:7141", "https://127.0.0.1:7141", "http://192.168.1.5:7141", "http://mac.tail.ts.net:7141"].map(t),
			["http://127.0.0.1:7141", "http://[::1]:7141", undefined, undefined, undefined],
		);
	});
});
