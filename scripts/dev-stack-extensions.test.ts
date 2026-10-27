import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script
import { bundleState, planExtensionInstalls } from "./dev-stack-extensions.mjs";

let tmp: string;
beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devstack-ext-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const touch = (p: string, mtimeMs: number, body = "x") => {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, body);
	fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
};
const dirOf = (k: string) => (k === "memory" ? "wolfpack-memory" : undefined);

function fixture() {
	const repo = path.join(tmp, "repo");
	const wolves = path.join(tmp, "wolves");
	const sandbox = path.join(tmp, "sandbox");
	touch(path.join(repo, "extensions/wolfpack-memory/index.ts"), 1_000_000);
	touch(path.join(repo, "extensions/wolfpack-memory/index.test.ts"), 9_000_000); // tests never invalidate
	touch(path.join(repo, "packages/engine/src/a.ts"), 1_000_000);
	const wolf = (name: string, yaml: string) => touch(path.join(wolves, name, "wolf.yaml"), 1, yaml);
	return { repo, wolves, sandbox, wolf };
}

describe("bundleState", () => {
	it("missing / stale / fresh by mtime against the source roots", () => {
		const f = fixture();
		const roots = [path.join(f.repo, "extensions/wolfpack-memory"), path.join(f.repo, "packages/engine/src")];
		const bundle = path.join(f.sandbox, "dens/a/extensions/wolfpack-memory/index.js");
		expect(bundleState(bundle, roots)).toBe("missing");
		touch(bundle, 500_000);
		expect(bundleState(bundle, roots)).toBe("stale");
		touch(bundle, 2_000_000);
		expect(bundleState(bundle, roots)).toBe("fresh");
		touch(path.join(f.repo, "packages/engine/src/b.ts"), 3_000_000); // a bundled dependency changed
		expect(bundleState(bundle, roots)).toBe("stale");
	});
});

describe("planExtensionInstalls", () => {
	it("installs sandboxed wolves with stale/missing bundles, skips fresh ones, only warns for non-sandbox", () => {
		const f = fixture();
		f.wolf("stale-dev", `name: stale-dev\nextensions: [memory]\nsandbox:\n  root: ${f.sandbox}\n`);
		f.wolf("fresh-dev", `name: fresh-dev\nextensions: [memory]\nsandbox:\n  root: ${f.sandbox}\n`);
		f.wolf("noext", `name: noext\nsandbox:\n  root: ${f.sandbox}\n`);
		f.wolf("plain", `name: plain\nden: ${path.join(tmp, "plain-den")}\nextensions: [memory]\n`);
		touch(path.join(f.sandbox, "dens/stale-dev/extensions/wolfpack-memory/index.js"), 500_000);
		touch(path.join(f.sandbox, "dens/fresh-dev/extensions/wolfpack-memory/index.js"), 2_000_000);
		touch(path.join(tmp, "plain-den/extensions/wolfpack-memory/index.js"), 500_000);

		const plans = planExtensionInstalls({ wolvesDir: f.wolves, repo: f.repo, dirOf });
		expect(plans.map((p: { wolf: string; action: string }) => [p.wolf, p.action])).toEqual([
			["fresh-dev", "ok"],
			["plain", "warn"],
			["stale-dev", "install"],
		]);
		const stale = plans.find((p: { wolf: string }) => p.wolf === "stale-dev");
		expect(stale.den).toBe(path.join(f.sandbox, "dens/stale-dev"));
		expect(stale.keys).toEqual(["memory"]);
	});
});
