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
