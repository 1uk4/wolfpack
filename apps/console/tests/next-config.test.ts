/** Anti-framing headers are configured for every route (the tracer proof checks them on the live server too). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import nextConfig from "../next.config.ts";

describe("next.config headers", () => {
	it("every route gets CSP frame-ancestors 'none' and X-Frame-Options DENY", async () => {
		const rules = await nextConfig.headers!();
		const all = rules.find((r) => r.source === "/:path*");
		assert.ok(all);
		const h = Object.fromEntries(all.headers.map((x) => [x.key, x.value]));
		assert.equal(h["Content-Security-Policy"], "frame-ancestors 'none'");
		assert.equal(h["X-Frame-Options"], "DENY");
	});
});
