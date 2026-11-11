import assert from "node:assert/strict";
import { test } from "node:test";
import { hubPublicUrl } from "../../../src/server/pack/hub-public-url.ts";
import { pairLink } from "../../../src/server/pack/devices-api.ts";

test("hubPublicUrl: runtime env, first name wins, trailing slashes trimmed, blank = unset", () => {
	assert.equal(hubPublicUrl({}), undefined);
	assert.equal(hubPublicUrl({ HUBD_PUBLIC_URL: " " }), undefined);
	assert.equal(hubPublicUrl({ HUBD_PUBLIC_URL: "https://h.ts.net/hub/" }), "https://h.ts.net/hub");
	assert.equal(hubPublicUrl({ WOLFPACK_HUB_PUBLIC_URL: "https://a/hub", HUBD_PUBLIC_URL: "https://b/hub" }), "https://a/hub");
	assert.equal(hubPublicUrl({ NEXT_PUBLIC_WOLFPACK_HUB_URL: "https://old/hub" }), "https://old/hub");
});

test("pairLink: /hub/pair with no trailing slash, code encoded", () => {
	assert.equal(pairLink("A B", "https://h.ts.net/hub"), "https://h.ts.net/hub/pair?code=A%20B");
	assert.equal(pairLink("x", undefined), undefined);
});
