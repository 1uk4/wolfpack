/** Seam: scripts/check-app.mjs as a CLI, run on a fake bundle. Catches crashes of the --sign-only path; does not prove real signatures (needs a built app). */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";

/** Runs check-app --sign-only on an unsigned fake bundle; `env` overrides the child's environment. */
function runOnFakeBundle(env: NodeJS.ProcessEnv, inRuntime?: (runtime: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-app-"));
  try {
    const app = path.join(dir, "Fake.app");
    fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    fs.mkdirSync(path.join(app, "Contents", "Resources", "runtime"), { recursive: true });
    inRuntime?.(path.join(app, "Contents", "Resources", "runtime"));
    fs.writeFileSync(path.join(app, "Contents", "MacOS", "Fake"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    return spawnSync(process.execPath, [path.resolve(__dirname, "../scripts/check-app.mjs"), app, "--sign-only"], { encoding: "utf8", env });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const noCrash = /ReferenceError|TypeError|at file:|node:internal/;

it("fails a bundle that carries any plug-in package (plug-ins live in the user's state, not in the app)", () => {
  const r = runOnFakeBundle({ ...process.env }, (runtime) => {
    fs.mkdirSync(path.join(runtime, "plugins", "example-provider"), { recursive: true });
    fs.writeFileSync(path.join(runtime, "plugins", "example-provider", "package.json"), '{"name":"example-provider"}');
  });
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/FAIL runtime ships a plug-in package/);
  expect(r.stderr).not.toMatch(noCrash);
});

it("fails a bundle that carries a package with a wolfpack plug-in manifest anywhere in the runtime", () => {
  const r = runOnFakeBundle({ ...process.env }, (runtime) => {
    fs.mkdirSync(path.join(runtime, "node_modules", "@scope", "example-provider"), { recursive: true });
    fs.writeFileSync(path.join(runtime, "node_modules", "@scope", "example-provider", "package.json"), '{"name":"@scope/example-provider","wolfpack":{"entry":"x.js"}}');
  });
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/FAIL runtime ships a plug-in package/);
});

it("--sign-only reports a missing codesign as one FAIL, not a crash (Linux CI has no codesign)", () => {
  const r = runOnFakeBundle({ ...process.env, PATH: path.join(os.tmpdir(), "no-such-bin-dir") });
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/FAIL codesign is not available \(ENOENT\)/);
  expect(r.stderr.match(/FAIL codesign/g)).toHaveLength(1);
  expect(r.stderr).toMatch(/check-app: \d+ problem\(s\)/);
  expect(r.stderr).not.toMatch(noCrash);
});

it.skipIf(process.platform !== "darwin")("--sign-only on an unsigned fake bundle fails each signature check, not a crash", () => {
  const r = runOnFakeBundle({ ...process.env });
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/FAIL codesign: /);
  expect(r.stderr).toMatch(/FAIL .*not Developer ID Application/);
  expect(r.stderr).toMatch(/check-app: \d+ problem\(s\)/);
  expect(r.stderr).not.toMatch(noCrash);
});
