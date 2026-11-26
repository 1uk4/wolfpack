import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { GraphCanvasRenderer } from "../../../components/graph/graph-canvas.ts";

/** A canvas stand-in: just enough surface for the renderer's constructor and d3-zoom. */
function fakeCanvas(): HTMLCanvasElement {
	const ctx = new Proxy({}, { get: () => () => undefined, set: () => true });
	const style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => "", cursor: "" };
	return {
		getContext: () => ctx,
		addEventListener() {},
		removeEventListener() {},
		style,
		clientWidth: 400,
		clientHeight: 300,
		width: 400,
		height: 300,
		getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }),
	} as unknown as HTMLCanvasElement;
}

describe("graph renderer after destroy", () => {
	const g = globalThis as unknown as Record<string, unknown>;
	let rafs = 0;
	beforeEach(() => {
		rafs = 0;
		g.requestAnimationFrame = () => ++rafs;
		g.cancelAnimationFrame = () => {};
		g.Path2D = class {};
		g.window = { devicePixelRatio: 1 };
		g.ResizeObserver = class {
			observe() {}
			disconnect() {}
		};
	});
	afterEach(() => {
		delete g.requestAnimationFrame;
		delete g.cancelAnimationFrame;
		delete g.Path2D;
		delete g.window;
		delete g.ResizeObserver;
	});

	it("setOverlay(null) and a redraw request schedule no frame once destroyed", () => {
		const r = new GraphCanvasRenderer(fakeCanvas(), { onCameraMove() {} } as never);
		r.destroy();
		rafs = 0;
		r.setOverlay(null);
		r.requestRedraw();
		assert.equal(rafs, 0);
	});
});
