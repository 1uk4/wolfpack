/**
 * Seam: ensureWorkAccess (electron/work-access.cjs), driven against a fake hubd on 127.0.0.1 and a temp wolf folder.
 * Catches: what lands in the wolf's .env, the default domain and subscription, re-minting a refused token.
 * Misses: that real hubd accepts the console token on /v1/workapi (the supervisor integration test needs apps/desktop/runtime built).
 */
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { ensureWorkAccess } = createRequire(import.meta.url)("./work-access.cjs");

let hub: Server;
let hubUrl: string;
let wolfDir: string;
let validTokens: Set<string>;
let domains: Set<string>;
let wolfDomains: string[] | null;
let minted: number;

beforeEach(async () => {
	validTokens = new Set(["good-token"]);
	domains = new Set(["personal"]);
	wolfDomains = ["personal"];
	minted = 0;
	wolfDir = mkdtempSync(join(tmpdir(), "work-access-"));
	writeFileSync(join(wolfDir, "wolf.yaml"), "id: luka\ndomains: [personal]\nmemory:\n  live: true\n");
	hub = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const json = (s: number, o: unknown) => res.writeHead(s, { "content-type": "application/json" }).end(JSON.stringify(o));
			const u = new URL(req.url ?? "/", "http://x");
			if (u.pathname === "/v1/workapi/work") return validTokens.has(String(req.headers["x-api-key"])) ? json(200, { items: [] }) : json(401, { error: "no" });
			if (req.headers.authorization !== "Bearer hub-token") return json(401, { error: "no" });
			const dm = /^\/v1\/registry\/domains\/(.+)$/.exec(u.pathname);
			if (dm) return domains.has(dm[1]) ? json(200, { domain: { name: dm[1] } }) : json(404, { error: "nf" });
			if (u.pathname === "/v1/registry/domains" && req.method === "POST") return domains.add(JSON.parse(body).name), json(201, {});
			if (u.pathname === "/v1/registry/wolves" && req.method === "POST") return (wolfDomains = JSON.parse(body).domains), json(201, {});
			if (u.pathname === "/v1/registry/wolves/luka") {
				if (req.method === "PATCH") return (wolfDomains = JSON.parse(body).domains), json(200, {});
				return wolfDomains ? json(200, { wolf: { name: "luka", domains: wolfDomains } }) : json(404, { error: "nf" });
			}
			json(404, { error: "nf" });
		});
	});
	await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
	hubUrl = `http://127.0.0.1:${(hub.address() as { port: number }).port}`;
});
afterEach(() => new Promise((r) => hub.close(r)));

const run = () =>
	ensureWorkAccess({ wolfDir, wolfId: "luka", hubUrl, hubToken: "hub-token", mintToken: async () => (minted++, validTokens.add("fresh-token"), "fresh-token") });

describe("work access for the app's wolf", () => {
	it("first launch: mints a token, writes WORK_* to a 0600 .env, creates the wolf-named domain and subscribes the wolf", async () => {
		await run();
		expect(readFileSync(join(wolfDir, ".env"), "utf8")).toBe(`WORK_ENDPOINT=${hubUrl}/v1/workapi\nWORK_TOKEN=fresh-token\n`);
		expect(statSync(join(wolfDir, ".env")).mode & 0o777).toBe(0o600);
		expect(domains.has("luka")).toBe(true);
		expect(wolfDomains).toEqual(["personal", "luka"]);
		expect(readFileSync(join(wolfDir, "wolf.yaml"), "utf8")).toContain("domains: [personal, luka]");
	});

	it("upgrade: an existing .env without WORK_* gets them added and its other lines stay", async () => {
		writeFileSync(join(wolfDir, ".env"), "CLAUDE_CODE_OAUTH_TOKEN=abc\n# keep me\nFOO=bar\n", { mode: 0o644 });
		await run();
		expect(readFileSync(join(wolfDir, ".env"), "utf8")).toBe(`CLAUDE_CODE_OAUTH_TOKEN=abc\n# keep me\nFOO=bar\nWORK_ENDPOINT=${hubUrl}/v1/workapi\nWORK_TOKEN=fresh-token\n`);
		expect(statSync(join(wolfDir, ".env")).mode & 0o777).toBe(0o600);
	});

	it("is idempotent: a token hubd still accepts is reused, and a second run changes nothing", async () => {
		writeFileSync(join(wolfDir, ".env"), "WORK_TOKEN=good-token\n");
		await run();
		await run();
		expect(minted).toBe(0);
		expect(readFileSync(join(wolfDir, ".env"), "utf8")).toBe(`WORK_TOKEN=good-token\nWORK_ENDPOINT=${hubUrl}/v1/workapi\n`);
		expect(wolfDomains).toEqual(["personal", "luka"]);
	});

	it("re-mints when hubd rejects the stored token, replacing it in place (a new port updates the endpoint too)", async () => {
		writeFileSync(join(wolfDir, ".env"), "WORK_ENDPOINT=http://127.0.0.1:1/v1/workapi\nWORK_TOKEN=revoked\nFOO=bar\n");
		await run();
		expect(minted).toBe(1);
		expect(readFileSync(join(wolfDir, ".env"), "utf8")).toBe(`WORK_ENDPOINT=${hubUrl}/v1/workapi\nWORK_TOKEN=fresh-token\nFOO=bar\n`);
	});

	it("registers the wolf with the default domain when the hub has no entry for it", async () => {
		wolfDomains = null;
		await run();
		expect(wolfDomains).toEqual(["personal", "luka"]);
	});
});
