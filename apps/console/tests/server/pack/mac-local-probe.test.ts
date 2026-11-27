import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { probeMacLocalServices } from "../../../src/server/pack/mac-local-probe.ts";

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
async function deadUrl(): Promise<string> {
	const s = createServer();
	await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
	const port = (s.address() as AddressInfo).port;
	await new Promise((r) => s.close(r));
	return `http://127.0.0.1:${port}`;
}

describe("probeMacLocalServices", () => {
	it("reads the running hubd and workerd versions from this Mac's local /healthz, and reports a service that is down as not up", async () => {
		const hub = await serve({ service: "hubd", status: "ok", version: "0.1.25" });
		const worker = await serve({ service: "workerd", status: "ok", version: "0.1.12" });
		const up = await probeMacLocalServices({ WOLFPACK_HEALTH_HUB_URL: hub, WOLFPACK_HEALTH_WORKERDS: `workerd=${worker}` });
		assert.deepEqual(up, { hubd: { up: true, version: "0.1.25" }, workerd: { up: true, version: "0.1.12" } });
		const down = await probeMacLocalServices({ WOLFPACK_HEALTH_HUB_URL: await deadUrl(), WOLFPACK_HEALTH_WORKERDS: `workerd=${worker}` });
		assert.deepEqual(down, { hubd: { up: false, version: null }, workerd: { up: true, version: "0.1.12" } });
	});
});
