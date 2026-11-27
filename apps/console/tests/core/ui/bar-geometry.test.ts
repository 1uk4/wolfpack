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
		assert.deepEqual(barGeometry({ colLeft: 100, colWidth: 470, viewportWidth: 1440 }), { left: 335, width: 438, compact: true });
	});

	it("keeps a 420px bar on a column narrower than that, centred as nearly as it can and fully on screen", () => {
		// The 160px column of sidebar-open + reader-open at 1280: 288..448, centre 368.
		assert.deepEqual(barGeometry({ colLeft: 288, colWidth: 160, viewportWidth: 1280 }), { left: 368, width: 420, compact: true });
		// A narrow column at the window edge: the bar is pushed in, 16px clear of the edge.
		assert.deepEqual(barGeometry({ colLeft: 0, colWidth: 100, viewportWidth: 1280 }), { left: 226, width: 420, compact: true });
		assert.deepEqual(barGeometry({ colLeft: 1180, colWidth: 100, viewportWidth: 1280 }), { left: 1054, width: 420, compact: true });
		// A window narrower than 420 + 2 gaps: the bar shrinks to fit.
		assert.deepEqual(barGeometry({ colLeft: 0, colWidth: 100, viewportWidth: 400 }), { left: 200, width: 368, compact: true });
	});

	it("centres on the window when the column is wider than it, or unmeasured", () => {
		assert.deepEqual(barGeometry({ colLeft: -200, colWidth: 2000, viewportWidth: 1000 }), { left: 500, width: 900, compact: false });
		assert.deepEqual(barGeometry({ colLeft: 0, colWidth: 0, viewportWidth: 1000 }), { left: 500, width: 900, compact: false });
	});
});
