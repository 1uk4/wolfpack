/**
 * The dictation keyless seam (owner dictation trio): the client-authored
 * short line, and the click that opens the Pack page at Keys.
 */

import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { DICTATION_KEYLESS, openDeepgramKeyInPack } from "../../../components/composer/dictation.tsx";
import { setPackNavigator } from "../../../components/pack/pack-nav.ts";

const priorWindow = (globalThis as Record<string, unknown>).window;
Object.assign(globalThis, { window: { location: { pathname: "/", search: "", origin: "http://localhost:3210" }, sessionStorage: { getItem: () => null, setItem: () => {} } } });
after(() => void ((globalThis as Record<string, unknown>).window = priorWindow));
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
