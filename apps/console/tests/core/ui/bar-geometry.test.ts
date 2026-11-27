import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { barGeometry } from "../../../src/core/ui/bar-geometry.ts";

describe("barGeometry", () => {
	it("centres on the column and caps at 900px", () => {
		// A 1440px window with a 260px sidebar: the column runs 260..1440, its centre is 850.
		assert.deepEqual(barGeometry({ colLeft: 260, colWidth: 1180, viewportWidth: 1440 }), { left: 850, width: 900, compact: false });
	});

	it("keeps 16px clear of a narrow column's edges and goes compact under 460px", () => {
		assert.deepEqual(barGeometry({ colLeft: 0, colWidth: 600, viewportWidth: 1440 }), { left: 300, width: 568, compact: false });
		assert.deepEqual(barGeometry({ colLeft: 100, colWidth: 400, viewportWidth: 1440 }), { left: 300, width: 368, compact: true });
	});

	it("centres on the window when the column is wider than it, or unmeasured", () => {
		assert.deepEqual(barGeometry({ colLeft: -200, colWidth: 2000, viewportWidth: 1000 }), { left: 500, width: 900, compact: false });
		assert.deepEqual(barGeometry({ colLeft: 0, colWidth: 0, viewportWidth: 1000 }), { left: 500, width: 900, compact: false });
	});
});
