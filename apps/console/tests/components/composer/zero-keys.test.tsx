/**
 * The dictation keyless seam (owner dictation trio): the client-authored
 * short line, and the click that opens the Pack at Keys.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DICTATION_KEYLESS, openDeepgramKeyInPack } from "../../../components/composer/dictation.tsx";
import { closePackHealth, getPackHealth, requestedPackSection } from "../../../components/pack/pack-health-store.ts";

describe("the dictation keyless seam (owner dictation trio)", () => {
	it("the client-authored short line — not the route's dev-speak", () => {
		assert.equal(DICTATION_KEYLESS, "Dictation needs a Deepgram key");
	});

	it("the keyless click opens the Pack on Keys", () => {
		openDeepgramKeyInPack();
		assert.equal(getPackHealth().modalOpen, true);
		assert.equal(requestedPackSection(), "keys");
		closePackHealth();
	});
});
