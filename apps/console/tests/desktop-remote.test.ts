/** Remote-console mode: URL validation, config precedence, origin pinning helpers. */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { parseConsoleUrl, resolveConsoleTarget, sameOrigin, errorPageHtml } = require("../../desktop/electron/remote.cjs");

describe("parseConsoleUrl", () => {
	it("accepts https and normalizes to origin + path", () => {
		const r = parseConsoleUrl("https://sfo-01.tail4f0118.ts.net");
		assert.deepEqual([r.ok, r.url, r.origin], [true, "https://sfo-01.tail4f0118.ts.net/", "https://sfo-01.tail4f0118.ts.net"]);
		assert.equal(parseConsoleUrl("https://h.ts.net/c/?x=1#y").url, "https://h.ts.net/c/");
	});
	it("allows http only for loopback and tailnet IPs", () => {
		for (const u of ["http://127.0.0.1:3210", "http://localhost:3000", "http://100.101.2.3", "http://[::1]:1"]) assert.equal(parseConsoleUrl(u).ok, true, u);
		for (const u of ["http://example.com", "http://100.10.0.1", "http://192.168.1.2"]) assert.equal(parseConsoleUrl(u).ok, false, u);
	});
	it("rejects credentials, other schemes, junk", () => {
		for (const u of ["https://a:b@h.ts.net", "https://u@h.ts.net", "ftp://h", "javascript:alert(1)", "nope", "", undefined]) assert.equal(parseConsoleUrl(u as string).ok, false, String(u));
	});
});

describe("resolveConsoleTarget", () => {
	const dir = mkdtempSync(join(tmpdir(), "lh-remote-"));
	it("local when nothing is configured", () => assert.deepEqual(resolveConsoleTarget({ env: {}, userDataDir: dir }), { mode: "local" }));
	it("reads console.json, env overrides it", () => {
		writeFileSync(join(dir, "console.json"), JSON.stringify({ consoleUrl: "https://file.ts.net" }));
		assert.equal(resolveConsoleTarget({ env: {}, userDataDir: dir }).origin, "https://file.ts.net");
		assert.equal(resolveConsoleTarget({ env: { LH_CONSOLE_URL: "https://env.ts.net" }, userDataDir: dir }).origin, "https://env.ts.net");
	});
	it("invalid value logs and falls back to local", () => {
		const logs: string[] = [];
		assert.deepEqual(resolveConsoleTarget({ env: { LH_CONSOLE_URL: "http://evil.com" }, userDataDir: dir, log: (m: string) => logs.push(m) }), { mode: "local" });
		assert.equal(logs.length, 1);
	});
	it("broken json falls back to local", () => {
		const d = mkdtempSync(join(tmpdir(), "lh-remote-"));
		writeFileSync(join(d, "console.json"), "{oops");
		assert.deepEqual(resolveConsoleTarget({ env: {}, userDataDir: d }), { mode: "local" });
	});
});

describe("origin helpers", () => {
	it("sameOrigin pins scheme+host+port; /hub/pair is same-origin", () => {
		const o = "https://h.ts.net";
		assert.equal(sameOrigin("https://h.ts.net/hub/pair?code=1", o), true);
		assert.equal(sameOrigin("https://h.ts.net/pair#token=x", o), true);
		assert.equal(sameOrigin("http://h.ts.net/", o), false);
		assert.equal(sameOrigin("https://h.ts.net.evil.com/", o), false);
		assert.equal(sameOrigin("garbage", o), false);
	});
	it("error page escapes the url and has a Retry", () => {
		const h = errorPageHtml('https://x/"><script>');
		assert.ok(!h.includes("<script>") && h.includes("Retry") && h.includes("Is Tailscale connected?"));
	});
});
