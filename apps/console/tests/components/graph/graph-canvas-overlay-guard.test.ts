import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { GraphCanvasRenderer } from "../../../components/graph/graph-canvas.ts";

const handlers: Record<string, (e: unknown) => void> = {};
function fakeCanvas(): HTMLCanvasElement {
	const ctx = new Proxy({}, { get: () => () => undefined, set: () => true });
	const style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => "", cursor: "" };
	return {
		getContext: () => ctx,
		addEventListener: (type: string, fn: (e: unknown) => void) => void (handlers[type] = fn),
		removeEventListener() {},
		style,
		clientWidth: 400,
		clientHeight: 300,
		width: 400,
		height: 300,
		getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }),
	} as unknown as HTMLCanvasElement;
}

describe("graph renderer with a failing live overlay", () => {
	const g = globalThis as unknown as Record<string, unknown>;
	beforeEach(() => {
		g.requestAnimationFrame = () => 1;
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

	it("an overlay that throws is switched off for the session and the graph keeps handling input", () => {
		const r = new GraphCanvasRenderer(fakeCanvas(), { onCameraMove() {} } as never);
		let calls = 0;
		const bad = {
			hitTest() {
				calls++;
				throw new Error("overlay bug");
			},
		};
		const log = console.error;
		let logged = 0;
		console.error = () => void logged++;
		try {
			r.setOverlay(bad as never);
			const move = { clientX: 5, clientY: 5, pointerType: "mouse", buttons: 0, pointerId: 1 };
			assert.doesNotThrow(() => handlers.pointermove!(move));
			assert.doesNotThrow(() => handlers.pointermove!(move));
		} finally {
			console.error = log;
		}
		assert.equal(calls, 1);
		assert.equal(logged, 1);
		r.destroy();
	});
});
