/** Seam: the setup wizard's prefilled wolf name (electron/wolf-name.cjs), checked together with the id setup derives from it. */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { suggestedWolfName } = require("./wolf-name.cjs");
const { wolfIdFor } = require("./setup.cjs");

describe("suggested wolf name", () => {
	it("is 'Alpha wolf' (id alpha-wolf) for every Mac user, not the account's first name", () => {
		expect(suggestedWolfName()).toBe("Alpha wolf");
		expect(wolfIdFor(suggestedWolfName())).toBe("alpha-wolf");
	});
});
