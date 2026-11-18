/** Seam: windowAllClosedAction (electron/tray.cjs), what happens when the last window closes. */
import { createRequire } from "node:module";
import { expect, it } from "vitest";

const { windowAllClosedAction } = createRequire(import.meta.url)("./tray.cjs");

it("hides instead of quitting when the last window closes in app runtime, so the wolves keep running", () => {
  expect(windowAllClosedAction({ appRuntime: true, platform: "darwin" })).toBe("hide");
  // Remote/dev modes keep today's behaviour.
  expect(windowAllClosedAction({ appRuntime: false, platform: "darwin" })).toBe("stay");
  expect(windowAllClosedAction({ appRuntime: false, platform: "linux" })).toBe("quit");
});
