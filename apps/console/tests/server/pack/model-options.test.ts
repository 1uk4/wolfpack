/** Seam: packModelOptions (src/server/pack/model-options.ts): the catalog the Wolves pickers offer. Ids and names only, never key data. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { packModelOptions } from "../../../src/server/pack/model-options.ts";

describe("packModelOptions", () => {
	it("returns only id, name and provider for each model, and offers Anthropic models", () => {
		const models = packModelOptions();
		assert.ok(models.some((m) => m.provider === "anthropic"));
		for (const m of models) assert.deepEqual(Object.keys(m).sort(), ["id", "name", "provider"]);
	});
});
