import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { stampedVersion } from "./health-lag.js";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const at = (...p: string[]) => pathToFileURL(join(dir, ...p));

describe("stampedVersion", () => {
  it("prefers the first VERSION stamp that exists over package.json", () => {
    dir = mkdtempSync(join(tmpdir(), "stamp-"));
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.1.0" }));
    writeFileSync(join(dir, "VERSION"), "0.1.14+90091017\n");
    expect(stampedVersion([at("dist", "VERSION"), at("VERSION")], at("package.json"))).toBe("0.1.14+90091017");
  });

  it("falls back to <package.json version>-dev when nothing is stamped, and undefined when neither is readable", () => {
    dir = mkdtempSync(join(tmpdir(), "stamp-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.1.0" }));
    writeFileSync(join(dir, "VERSION"), "  \n"); // an empty stamp counts as none
    expect(stampedVersion([at("VERSION")], at("package.json"))).toBe("0.1.0-dev");
    expect(stampedVersion([at("VERSION")], at("missing.json"))).toBeUndefined();
  });
});
