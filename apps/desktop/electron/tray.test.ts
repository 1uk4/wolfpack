/** Seam: windowAllClosedAction (electron/tray.cjs), what happens when the last window closes. */
import { createRequire } from "node:module";
import { expect, it } from "vitest";

const { windowAllClosedAction, focusFirstWindow } = createRequire(import.meta.url)("./tray.cjs");

it("hides instead of quitting when the last window closes in app runtime, so the wolves keep running", () => {
  expect(windowAllClosedAction({ appRuntime: true, platform: "darwin" })).toBe("hide");
  // Remote/dev modes keep today's behaviour.
  expect(windowAllClosedAction({ appRuntime: false, platform: "darwin" })).toBe("stay");
  expect(windowAllClosedAction({ appRuntime: false, platform: "linux" })).toBe("quit");
});

it("brings a minimised or tray-hidden window forward, and does nothing without a window", () => {
  const mk = (minimized: boolean, visible: boolean) => {
    const calls: string[] = [];
    return { calls, isMinimized: () => minimized, isVisible: () => visible, restore: () => calls.push("restore"), show: () => calls.push("show"), focus: () => calls.push("focus") };
  };
  const minimised = mk(true, true);
  focusFirstWindow(minimised);
  expect(minimised.calls).toEqual(["restore", "focus"]);
  const hidden = mk(false, false);
  focusFirstWindow(hidden);
  expect(hidden.calls).toEqual(["show", "focus"]);
  expect(() => focusFirstWindow(undefined)).not.toThrow();
});
