import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createUpdatesHandler } from "../src/server/updates-api.ts";

const servers: Server[] = [];
after(() => {
	for (const s of servers) {
		s.closeAllConnections();
		s.close();
	}
});
async function serve(body: unknown): Promise<string> {
	const s = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	});
	servers.push(s);
	await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
	return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
/** A port nothing listens on: the hub is down. */
async function deadUrl(): Promise<string> {
	const s = createServer();
	await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
	const port = (s.address() as AddressInfo).port;
	await new Promise((r) => s.close(r));
	return `http://127.0.0.1:${port}`;
}
const entry = (c: string, v: string) => ({ version: v, tag: `${c}/v${v}`, sha: "bfb4b5c3", publishedAt: "2026-11-09T03:21:10Z", notesUrl: `https://github.com/1uk4/wolfpack/releases/tag/${c}/v${v}` });

describe("GET /api/updates", () => {
	it("with the hub down, still compares the console and workerd against the manifest and reports hubd as unknown", async () => {
		const manifestBase = await serve({ schema: 1, generatedAt: "2026-11-09T03:30:00Z", components: { console: entry("console", "0.1.18"), hubd: entry("hubd", "0.1.14"), workerd: entry("workerd", "0.1.5"), wolfd: entry("wolfd", "0.1.14") } });
		const workerd = await serve({ ok: true, service: "workerd", version: "0.1.4+abc1234" });
		const dir = mkdtempSync(join(tmpdir(), "console-ver-"));
		writeFileSync(join(dir, "VERSION"), "0.1.18\n");
		try {
			const get = createUpdatesHandler({
				env: { WOLFPACK_UPDATE_MANIFEST_URL: `${manifestBase}/stable.json`, WOLFPACK_HUB_URL: await deadUrl(), WOLFPACK_API_URL: workerd },
				consoleDir: dir,
				probeTimeoutMs: 1_000,
			});
			const body = await get();
			assert.equal(body.manifestError, undefined);
			assert.deepEqual(
				body.components.map((c) => [c.component, c.running, c.latest, c.outdated]),
				[
					["console", "0.1.18", "0.1.18", false],
					["hubd", null, "0.1.14", null],
					["workerd", "0.1.4+abc1234", "0.1.5", true],
					["wolfd", null, "0.1.14", null],
				],
			);
			assert.equal(body.outdated, true);
			const w = body.components.find((c) => c.component === "workerd");
			assert.equal(w?.notesUrl, "https://github.com/1uk4/wolfpack/releases/tag/workerd/v0.1.5");
			assert.match(w?.updateStep ?? "", /runtime:update/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("shows the host's auto-update status file per component: failed with its code, updating, updated, idle, and disabled by the kill switch", async () => {
		const manifestBase = await serve({ schema: 1, generatedAt: "2026-11-09T03:30:00Z", components: { console: entry("console", "0.1.19"), hubd: entry("hubd", "0.1.15"), workerd: entry("workerd", "0.1.6"), wolfd: entry("wolfd", "0.1.15") } });
		const dir = mkdtempSync(join(tmpdir(), "console-ver-"));
		writeFileSync(join(dir, "VERSION"), "0.1.18\n");
		// The file scripts/auto-update.mjs writes on sfo-01 (schema 1).
		const unit = (component: string, current: string, target: string, state: string, extra = {}) => ({ component, current, target, state, ...extra });
		const status = {
			schema: 1,
			host: "sfo-01",
			enabled: true,
			lastCheck: "2026-11-09T04:00:00.000Z",
			result: "failed",
			units: {
				hubd: unit("hubd", "0.1.15", "0.1.15", "updated", { finishedAt: "2026-11-09T03:58:00.000Z" }),
				workerd: unit("workerd", "0.1.6", "0.1.6", "updated"),
				"workerd-wolves": unit("workerd", "0.1.5", "0.1.6", "failed", { code: "unhealthy", message: "/healthz on 127.0.0.1:7143: ECONNREFUSED" }),
				"wolfd@hal2": unit("wolfd", "0.1.14", "0.1.15", "updating", { startedAt: "2026-11-09T03:59:00.000Z" }),
				console: unit("console", "0.1.18", "0.1.19", "idle"),
			},
		};
		const statusFile = join(dir, "status.json");
		writeFileSync(statusFile, JSON.stringify(status));
		try {
			const now = () => Date.parse("2026-11-09T04:05:00.000Z"); // 5 min after lastCheck: fresh, so no `stale`
			const get = createUpdatesHandler({ env: { WOLFPACK_UPDATE_MANIFEST_URL: `${manifestBase}/stable.json`, WOLFPACK_AUTO_UPDATE_STATUS: statusFile }, consoleDir: dir, now });
			const by = Object.fromEntries((await get()).components.map((c) => [c.component, c.updateStatus]));
			assert.deepEqual(by.hubd, { state: "updated", host: "sfo-01", lastCheck: "2026-11-09T04:00:00.000Z", at: "2026-11-09T03:58:00.000Z" });
			assert.deepEqual(by.workerd, { state: "failed", host: "sfo-01", lastCheck: "2026-11-09T04:00:00.000Z", unit: "workerd-wolves", code: "unhealthy", message: "/healthz on 127.0.0.1:7143: ECONNREFUSED" });
			assert.deepEqual(by.wolfd, { state: "updating", host: "sfo-01", lastCheck: "2026-11-09T04:00:00.000Z", unit: "wolfd@hal2", at: "2026-11-09T03:59:00.000Z" });
			assert.deepEqual(by.console, { state: "idle", host: "sfo-01", lastCheck: "2026-11-09T04:00:00.000Z" });

			writeFileSync(statusFile, JSON.stringify({ ...status, enabled: true, result: "disabled", disabledReason: "kill switch: /var/lib/wolfpack-auto-update/auto-update.disabled exists", units: { ...status.units, console: unit("console", "0.1.18", "0.1.19", "disabled") } }));
			const again = await createUpdatesHandler({ env: { WOLFPACK_UPDATE_MANIFEST_URL: `${manifestBase}/stable.json`, WOLFPACK_AUTO_UPDATE_STATUS: statusFile }, consoleDir: dir, now })();
			assert.deepEqual(
				again.components.find((c) => c.component === "console")?.updateStatus,
				{ state: "disabled", host: "sfo-01", lastCheck: "2026-11-09T04:00:00.000Z", message: "kill switch: /var/lib/wolfpack-auto-update/auto-update.disabled exists" },
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("marks the host updater stale when its last check is older than two 30-minute timer intervals; a recent check is not stale and no status file means no updater status", async () => {
		const manifestBase = await serve({ schema: 1, generatedAt: "2026-11-09T03:30:00Z", components: { console: entry("console", "0.1.18") } });
		const dir = mkdtempSync(join(tmpdir(), "console-ver-"));
		writeFileSync(join(dir, "VERSION"), "0.1.18\n");
		const statusFile = join(dir, "status.json");
		const write = (lastCheck: string) =>
			writeFileSync(statusFile, JSON.stringify({ schema: 1, host: "sfo-01", enabled: true, lastCheck, result: "ok", units: { console: { component: "console", current: "0.1.18", target: "0.1.18", state: "idle" } } }));
		const now = () => Date.parse("2026-11-09T12:00:00.000Z");
		const consoleStatus = async (file: string) =>
			(await createUpdatesHandler({ env: { WOLFPACK_UPDATE_MANIFEST_URL: `${manifestBase}/stable.json`, WOLFPACK_AUTO_UPDATE_STATUS: file }, consoleDir: dir, now })()).components.find((c) => c.component === "console")?.updateStatus;
		try {
			write("2026-11-09T09:00:00.000Z"); // 3 h: the timer has missed 6 runs
			assert.deepEqual(await consoleStatus(statusFile), { state: "idle", host: "sfo-01", lastCheck: "2026-11-09T09:00:00.000Z", stale: true });
			write("2026-11-09T11:35:00.000Z"); // 25 min: within one interval
			assert.deepEqual(await consoleStatus(statusFile), { state: "idle", host: "sfo-01", lastCheck: "2026-11-09T11:35:00.000Z" });
			assert.equal(await consoleStatus(join(dir, "missing.json")), undefined);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("with the manifest unreachable, answers with the running versions, nothing outdated, and the reason", async () => {
		const dir = mkdtempSync(join(tmpdir(), "console-ver-"));
		writeFileSync(join(dir, "VERSION"), "0.1.17\n");
		try {
			const body = await createUpdatesHandler({ env: { WOLFPACK_UPDATE_MANIFEST_URL: `${await deadUrl()}/stable.json` }, consoleDir: dir })();
			assert.equal(body.outdated, false);
			const { updateStep: _step, ...row } = body.components[0] ?? {};
			assert.deepEqual(row, { component: "console", running: "0.1.17", latest: null, outdated: null, notesUrl: null });
			assert.equal(body.manifestError, "ECONNREFUSED");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
