/** Seam: src/core/pack/pack-redirect.ts (work-wolfpack-oz3wvq3): where a page URL with ?pack=<section> goes. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { packRedirectTarget } from "../src/core/pack/pack-redirect.ts";

describe("packRedirectTarget", () => {
	it("goes to /pack/<section>, keeps wolf/wolfTab/view, and carries the origin page (minus pack params) in from", () => {
		assert.equal(packRedirectTarget("/work", "?pack=keys&x=1"), "/pack/keys?from=%2Fwork%3Fx%3D1");
		assert.equal(packRedirectTarget("/", "?pack=nope"), "/pack/machines?from=%2F");
		assert.equal(
			packRedirectTarget("/work", "?pack=wolves&wolf=sfo-01-wolves%2Fhal&view=prompt%3Asystem.ending-turn"),
			"/pack/wolves/sfo-01-wolves/hal/prompts?view=prompt%3Asystem.ending-turn&from=%2Fwork",
		);
	});
	it("leaves alone the API, the Pack itself, /pair, framework and static paths, and URLs without ?pack=", () => {
		for (const p of ["/api/x", "/pack/keys", "/pack", "/pair", "/_next/static/a.js", "/logo.png"]) assert.equal(packRedirectTarget(p, "?pack=keys"), null, p);
		assert.equal(packRedirectTarget("/work", "?view=prompt%3Ax"), null);
	});
});
