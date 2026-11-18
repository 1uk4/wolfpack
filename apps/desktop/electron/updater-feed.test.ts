import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const builderYml = readFileSync(join(here, "..", "electron-builder.yml"), "utf8");
const workflow = readFileSync(join(here, "..", "..", "..", ".github", "workflows", "desktop.yml"), "utf8");

/** The top-level `publish:` block, comments stripped. */
function publishBlock(): string {
  const start = builderYml.search(/^publish:/m);
  const rest = builderYml.slice(start);
  const firstLineEnd = rest.indexOf("\n") + 1;
  const next = rest.slice(firstLineEnd).search(/^\S/m);
  const block = next === -1 ? rest : rest.slice(0, firstLineEnd + next);
  return block
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
}

describe("desktop updater feed", () => {
  it("reads updates from the rolling desktop-latest release, not releases/latest", () => {
    const block = publishBlock();
    expect(block).toMatch(/provider:\s*generic/);
    expect(block).toMatch(/url:\s*https:\/\/github\.com\/1uk4\/wolfpack\/releases\/download\/desktop-latest\s*$/m);
    expect(block).not.toMatch(/provider:\s*github/);
  });

  it("the release job refreshes the rolling desktop-latest release with latest-mac.yml", () => {
    expect(workflow).toMatch(/gh release create desktop-latest --prerelease/);
    expect(workflow).toMatch(/gh release upload desktop-latest[^\n]*latest-mac\.yml[^\n]*--clobber/);
  });

});
