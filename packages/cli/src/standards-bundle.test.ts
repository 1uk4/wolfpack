import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { buildRemoteBundle, bundleExtension, stampExtension } from "./bundle.js";
import { extensionsDir, getExtension } from "./extensions.js";

const agentsSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../agents/src/index.ts");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "std-bundle-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("den bundle default prompts", () => {
  it("lets the bundled memory extension read the work-creation prompts with no repo checkout beside it", async () => {
    const dir = fs.mkdtempSync(path.join(tmp, "prompts-"));
    const built = await buildRemoteBundle({ name: "p", role: "tester", extensions: ["memory"] });
    fs.writeFileSync(path.join(dir, "agent.tgz"), Buffer.from(built.bundleB64, "base64"));
    execFileSync("tar", ["-xzf", path.join(dir, "agent.tgz"), "-C", dir]);
    const extDir = path.join(dir, "extensions", "wolfpack-memory");
    const probe = path.join(extDir, "probe.mjs");
    await esbuild.build({
      stdin: { contents: `import { newWorkPrompt } from ${JSON.stringify(agentsSrc)};\nconsole.log(newWorkPrompt([{ name: "demo", description: "d" }]));`, resolveDir: dir },
      outfile: probe, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    });
    const out = execFileSync("node", [probe], { encoding: "utf8" });
    expect(out).toContain("- **demo** — d");
    expect(out).not.toContain("{{");
  }, 30_000);
});

describe("extension build with shipped standards", () => {
  // A small extension: one agent profile (worker, which declares the testing and git standards) and optional assets.
  const fixture = (name: string, standardText?: string) => {
    const src = path.join(tmp, name, "src");
    fs.mkdirSync(path.join(src, "agents"), { recursive: true });
    fs.writeFileSync(path.join(src, "index.ts"), "export default 1;\n");
    fs.writeFileSync(path.join(src, "agents", "worker.md"), "---\nname: worker\nstandards: testing, git\n---\nbody\n");
    const pkg: Record<string, unknown> = { name: "fx", version: "1.0.0", pi: { extensions: ["./index.ts"], agents: ["./agents/*.md"] } };
    if (standardText !== undefined) {
      fs.mkdirSync(path.join(src, "standards"), { recursive: true });
      fs.writeFileSync(path.join(src, "standards", "testing.md"), standardText);
      fs.writeFileSync(path.join(src, "standards", "git.md"), "# Git standard\n");
      pkg.wolfpack = { assets: ["./standards"] };
    }
    fs.writeFileSync(path.join(src, "package.json"), JSON.stringify(pkg));
    return src;
  };
  const build = (src: string) => bundleExtension({ key: "fx", dir: "fx" } as never, src, path.join(path.dirname(src), "out"));

  it("fails when a profile needs a standard the built extension does not contain, and succeeds once it ships", async () => {
    await expect(build(fixture("missing"))).rejects.toThrow(/standard "testing"/);
    await expect(build(fixture("shipped", "# Testing standard\n"))).resolves.toMatchObject({ key: "fx" });
  });

  it("changes the stamp hash when a standard's content changes", async () => {
    // Same source dir for both builds: esbuild embeds source paths in its output, so a different dir would change the hash on its own.
    const src = fixture("edit", "# Testing standard\nrule one\n");
    const before = await build(src);
    fs.writeFileSync(path.join(src, "standards", "testing.md"), "# Testing standard\nrule two\n");
    const after = await build(src);
    expect(after.hash).not.toBe(before.hash);
  });

  it("gives the status stamp of the real memory extension the same hash as its build, so drift detection can't disagree with the bundle", async () => {
    const ext = getExtension("memory")!;
    const built = await bundleExtension(ext, path.join(extensionsDir(), ext.dir), path.join(tmp, "real-out"));
    expect((await stampExtension("memory"))?.hash).toBe(built.hash);
  });
});
