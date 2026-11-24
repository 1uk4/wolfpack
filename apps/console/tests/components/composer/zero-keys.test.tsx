/**
 * The dictation keyless seam (owner dictation trio): the client-authored
 * short line, and the click that opens the Pack page at Keys.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { DICTATION_KEYLESS, openDeepgramKeyInPack } from "../../../components/composer/dictation.tsx";
import { setPackNavigator } from "../../../components/pack/pack-nav.ts";

Object.assign(globalThis, { window: { location: { pathname: "/", search: "" }, sessionStorage: { getItem: () => null, setItem: () => {} } } });
afterEach(() => setPackNavigator(null));

describe("the dictation keyless seam (owner dictation trio)", () => {
	it("the client-authored short line — not the route's dev-speak", () => {
		assert.equal(DICTATION_KEYLESS, "Dictation needs a Deepgram key");
	});

	it("the keyless click opens the Pack page on Keys", () => {
		const went: string[] = [];
		setPackNavigator((h) => void went.push(h));
		openDeepgramKeyInPack();
		assert.deepEqual(went, ["/pack/keys"]);
	});
});
