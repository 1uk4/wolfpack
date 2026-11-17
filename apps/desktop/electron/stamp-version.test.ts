/** Seam: scripts/stamp-version.mjs as a CLI, run on a temp runtime + console payload. Catches a missing or wrong VERSION stamp; does not prove a built bundle finds it (smoke the packaged app). */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { stampedVersion } from "../../../packages/protocol/src/health-lag.ts";

const appVersion = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8")).version as string;

it("stamps every bundled component with the app's own version where the service reads it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stamp-version-"));
  try {
    const runtime = path.join(dir, "runtime");
    const payload = path.join(dir, "standalone");
    fs.mkdirSync(path.join(runtime, "wolfd"), { recursive: true });
    fs.mkdirSync(path.join(payload, "apps", "console"), { recursive: true });
    const r = spawnSync(process.execPath, [path.join(__dirname, "../scripts/stamp-version.mjs"), runtime, payload], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const pkg = pathToFileURL(path.join(dir, "no-package.json"));
    const beside = (file: string) => stampedVersion([pathToFileURL(path.join(path.dirname(file), "VERSION"))], pkg);
    // hubd.mjs and workerd.mjs read ./VERSION; wolfd.mjs reads ./VERSION in its own folder; the console (cwd apps/console) reads ../../VERSION.
    expect(beside(path.join(runtime, "hubd.mjs"))).toBe(appVersion);
    expect(beside(path.join(runtime, "wolfd", "wolfd.mjs"))).toBe(appVersion);
    expect(stampedVersion([pathToFileURL(path.join(payload, "apps", "console", "VERSION")), pathToFileURL(path.join(payload, "VERSION"))], pkg)).toBe(appVersion);
    expect(appVersion).toMatch(/^\d+\.\d+\.\d+$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
