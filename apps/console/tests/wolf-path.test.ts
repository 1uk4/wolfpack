/** Seam: src/core/pack/wolf-path.ts (work-wolfpack-iafGCfG): the wolf page's URL <-> (host, name, tab), and the redirects from the old query links. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseWolfPath, wolfPath, wolfRedirect } from "../src/core/pack/wolf-path.ts";

describe("wolf paths", () => {
	it("parses /pack/wolves/<host>/<name>[/<tab>]; no tab means models; the list and other paths are not a wolf", () => {
		assert.deepEqual(parseWolfPath("/pack/wolves/sfo-01-wolves/hal"), { hostId: "sfo-01-wolves", name: "hal", tab: "models" });
		assert.deepEqual(parseWolfPath("/pack/wolves/sfo-01-wolves/hal/prompts"), { hostId: "sfo-01-wolves", name: "hal", tab: "prompts" });
		assert.deepEqual(parseWolfPath("/pack/wolves/m/a%20b/yaml"), { hostId: "m", name: "a b", tab: "yaml" });
		assert.equal(parseWolfPath("/pack/wolves"), null);
		assert.equal(parseWolfPath("/pack/keys"), null);
	});
	it("keeps a malformed % escape in a segment as typed, and ignores extra segments after the tab", () => {
		assert.deepEqual(parseWolfPath("/pack/wolves/m/100%/models"), { hostId: "m", name: "100%", tab: "models" });
		assert.deepEqual(parseWolfPath("/pack/wolves/m/a/models/extra"), { hostId: "m", name: "a", tab: "models" });
		assert.deepEqual(parseWolfPath("/pack/wolves/m/a/nope/extra"), { hostId: "m", name: "a", tab: "models" });
	});
	it("builds the path with each segment encoded; models is the default and leaves no tab segment", () => {
		assert.equal(wolfPath("sfo-01-wolves", "hal"), "/pack/wolves/sfo-01-wolves/hal");
		assert.equal(wolfPath("sfo-01-wolves", "hal", "models"), "/pack/wolves/sfo-01-wolves/hal");
		assert.equal(wolfPath("m", "a b", "prompts"), "/pack/wolves/m/a%20b/prompts");
	});
	it("redirects old ?wolf=<h>/<n>&wolfTab=<t> links to the path, overview becomes models, view is kept", () => {
		assert.equal(wolfRedirect("/pack/wolves", "?wolf=mac%2Fhal&wolfTab=behaviour"), "/pack/wolves/mac/hal/behaviour");
		assert.equal(wolfRedirect("/pack/wolves", "?wolf=mac%2Fhal&wolfTab=overview"), "/pack/wolves/mac/hal");
		assert.equal(wolfRedirect("/pack/wolves", "?wolf=mac%2Fhal&wolfTab=prompts&view=prompt%3Ax"), "/pack/wolves/mac/hal/prompts?view=prompt%3Ax");
	});
	it("a ?view=prompt:<id> on a non-prompts wolf path redirects to the prompts path; on prompts or the list it does not", () => {
		assert.equal(wolfRedirect("/pack/wolves/mac/hal", "?view=prompt%3Ax"), "/pack/wolves/mac/hal/prompts?view=prompt%3Ax");
		assert.equal(wolfRedirect("/pack/wolves/mac/hal/models", "?view=prompt%3Ax"), "/pack/wolves/mac/hal/prompts?view=prompt%3Ax");
		assert.equal(wolfRedirect("/pack/wolves/mac/hal/prompts", "?view=prompt%3Ax"), null);
		assert.equal(wolfRedirect("/pack/wolves/mac/hal", ""), null);
		assert.equal(wolfRedirect("/pack/wolves", ""), null);
	});
});
