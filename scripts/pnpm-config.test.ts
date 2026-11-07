import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// The repo keeps npm's and pnpm's settings side by side (npm still builds the release, pnpm is for dev and CI).
// They must agree, or a dependency version differs between the two installs.
const root = new URL("..", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const workspace = parse(readFileSync(new URL("pnpm-workspace.yaml", root), "utf8"));

describe("npm and pnpm config agree", () => {
  it("pnpm-workspace.yaml overrides equal package.json overrides", () => {
    expect(workspace.overrides).toEqual(pkg.overrides);
  });

  it("pnpm-workspace.yaml lists the same workspace globs as package.json", () => {
    expect([...workspace.packages].sort()).toEqual([...pkg.workspaces].sort());
  });
});

/** Every package.json that takes part in an install: the root, each workspace package, and the extensions (installed via the root). */
function manifests(): Array<{ file: string; json: Record<string, Record<string, string> | string> }> {
  const dirs = [".", ...["packages", "apps", "extensions"].flatMap((d) => readdirSync(new URL(`${d}/`, root), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => `${d}/${e.name}`))];
  return dirs
    .filter((d) => existsSync(new URL(`${d}/package.json`, root)))
    .map((d) => ({ file: `${d}/package.json`.replace("./", ""), json: JSON.parse(readFileSync(new URL(`${d}/package.json`, root), "utf8")) }));
}
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

describe("workspace siblings stay npm-readable", () => {
  // pnpm links a sibling for "*" through linkWorkspacePackages; npm links it because the workspace satisfies "*".
  // Anything else (a range, workspace:*) either reaches the registry under npm or is unreadable to npm.
  it('every dependency on a workspace package is "*"', () => {
    const all = manifests();
    const names = new Set(
      all.filter((m) => /^(packages|apps)\//.test(m.file)).map((m) => m.json.name as string),
    );
    expect(names.size).toBeGreaterThan(5);
    const bad: string[] = [];
    for (const m of all) {
      for (const field of DEP_FIELDS) {
        for (const [dep, range] of Object.entries((m.json[field] ?? {}) as Record<string, string>)) {
          if (names.has(dep) && range !== "*") bad.push(`${m.file} ${field}.${dep} = ${range}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("allowBuilds covers the git dependency by the commit package.json pins", () => {
  it("the bridge's allowBuilds key carries the same sha as the dependency, so a bump cannot silently drop build permission", () => {
    const pins = new Set<string>();
    for (const m of manifests()) {
      for (const field of DEP_FIELDS) {
        for (const range of Object.values((m.json[field] ?? {}) as Record<string, string>)) {
          const sha = /pi-claude-bridge[^#]*#([0-9a-f]{40})$/.exec(range)?.[1];
          if (sha) pins.add(sha);
        }
      }
    }
    expect([...pins]).toHaveLength(1);
    const keys = Object.keys(workspace.allowBuilds).filter((k) => k.startsWith("pi-claude-bridge@"));
    expect(keys).toHaveLength(1);
    expect(keys[0]!.endsWith(`/${[...pins][0]}`)).toBe(true);
    expect(workspace.allowBuilds[keys[0]!]).toBe(true);
  });
});

describe("turbo never caches tests", () => {
  it("every task named test or test:* has cache: false", () => {
    const turbo = JSON.parse(readFileSync(new URL("turbo.json", root), "utf8")) as { tasks: Record<string, { cache?: boolean }> };
    const tests = Object.entries(turbo.tasks).filter(([name]) => /^test(:|$)/.test(name));
    expect(tests.length).toBeGreaterThan(0);
    for (const [name, task] of tests) expect(task.cache, name).toBe(false);
  });
});
