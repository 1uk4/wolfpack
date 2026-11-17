import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "claude-subscription-pack-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("pack.mjs", () => {
  it("builds a self-contained tarball that extracts to one claude-subscription folder and imports without the monorepo", () => {
    const out = join(tmp, "out");
    execFileSync("node", [join(pkgDir, "scripts/pack.mjs"), out], { cwd: tmp, stdio: "pipe" });
    const version = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version;
    const tgz = join(out, "dist", `claude-subscription-${version}.tgz`);
    for (const f of [tgz, `${tgz}.sha256`, join(out, "dist", "claude-subscription-latest.tgz"), join(out, "dist", "claude-subscription-latest.tgz.sha256")]) expect(existsSync(f), f).toBe(true);
    expect(readFileSync(`${tgz}.sha256`, "utf8").split(/\s+/)[0]).toBe(createHash("sha256").update(readFileSync(tgz)).digest("hex"));

    const ex = join(tmp, "extract");
    mkdirSync(ex);
    execFileSync("tar", ["-xzf", tgz, "-C", ex]);
    expect(readdirSync(ex)).toEqual(["claude-subscription"]);
    const manifest = JSON.parse(readFileSync(join(ex, "claude-subscription", "package.json"), "utf8"));
    expect(manifest.wolfpack).toMatchObject({ apiVersion: 1, entry: "./dist/index.js", providers: ["claude-subscription"], engineProviders: ["claude-subscription"], requiredEnv: ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_PATH", "WOLF_DEN"], optionalEnv: ["CLAUDE_CODE_NODE"] });
    // cwd is the temp dir and NODE_PATH is empty: nothing from the monorepo can resolve.
    const r = execFileSync("node", ["-e", `import(${JSON.stringify(join(ex, "claude-subscription", "dist", "index.js"))}).then((m) => console.log(m.default.apiVersion, typeof m.default.createProvider))`], { cwd: tmp, env: { PATH: process.env.PATH!, NODE_PATH: "" }, encoding: "utf8" });
    expect(r.trim()).toBe("1 function");
  }, 300_000);
});
