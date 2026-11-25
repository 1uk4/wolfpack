/** Viewer column width: clamp to [320, 70% of the window], one global persisted value, default 480. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { clampViewerWidth, readViewerWidth, writeViewerWidth, DEFAULT_VIEWER_WIDTH, VIEWER_WIDTH_KEY } = await import("../../../components/viewer/viewer-width.ts");

const mem = () => {
	const m = new Map<string, string>();
	return { m, s: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } };
};

describe("clampViewerWidth", () => {
	it("keeps a width inside [320, 70% of the window] and clamps outside it", () => {
		assert.equal(clampViewerWidth(500, 1400), 500);
		assert.equal(clampViewerWidth(100, 1400), 320);
		assert.equal(clampViewerWidth(5000, 1000), 700);
	});
	it("never goes below the minimum on a narrow window", () => {
		assert.equal(clampViewerWidth(600, 400), 320);
	});
});

describe("viewer width storage", () => {
	it("defaults to 480 when nothing or garbage is stored", () => {
		const { m, s } = mem();
		assert.equal(DEFAULT_VIEWER_WIDTH, 480);
		assert.equal(readViewerWidth(s), 480);
		m.set(VIEWER_WIDTH_KEY, "abc");
		assert.equal(readViewerWidth(s), 480);
	});
	it("round-trips a written width under the single global key", () => {
		const { m, s } = mem();
		writeViewerWidth(s, 612);
		assert.equal(m.get("wolfpack:viewer:width"), "612");
		assert.equal(readViewerWidth(s), 612);
	});
});
