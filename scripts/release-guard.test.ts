import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs
import { isEnvFile, scanArtifact, scanContent } from "./release-guard.mjs";

const dirs: string[] = [];
function tree(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "rg-test-"));
  dirs.push(d);
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(d, p, ".."), { recursive: true });
    writeFileSync(join(d, p), c);
  }
  return d;
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

// built at runtime so this file itself carries no token-shaped literal
const fake = {
  anthropic: "sk-ant-" + "api03-" + "A".repeat(40),
  ghp: "ghp_" + "a1B2".repeat(10),
  pat: "github_pat_" + "11AAAA".repeat(8),
  key: "-----BEGIN " + "OPENSSH PRIVATE KEY-----\n" + "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
  aws: "AKIA" + "ABCDEFGHIJKLMNOP",
};

describe("isEnvFile", () => {
  it("flags secret-bearing names, allows templates", () => {
    for (const n of [".env", "a/b/.env", ".env.local", "hubd.env"]) expect(isEnvFile(n)).toBe(true);
    for (const n of ["workerd.env.example", ".env.example", "x/.env.template", "environment.ts"]) expect(isEnvFile(n)).toBe(false);
  });
});

describe("scanContent", () => {
  it.each(Object.entries(fake))("detects %s", (_k, v) => expect(scanContent(Buffer.from(`x=${v}\n`)).length).toBe(1));
  it("passes ordinary text and short prefixes", () => {
    expect(scanContent(Buffer.from("prefix sk-ant- is documented; ghp_ too; BEGIN PRIVATE"))).toEqual([]);
    expect(scanContent(Buffer.from('const h = "-----BEGIN ' + 'PRIVATE KEY-----"; // pem header literal in a parser'))).toEqual([]);
    expect(scanContent(Buffer.from("AKIA" + "IOSFODNN7EXAMPLE"))).toEqual([]);
  });
});

describe("scanArtifact", () => {
  it("passes a clean dir and a clean tarball", () => {
    const d = tree({ "a.mjs": "console.log(1)", "workerd.env.example": "TOKEN=\n" });
    expect(scanArtifact(d)).toEqual([]);
    const t = join(d, "..", `rg-${Date.now()}.tgz`);
    execFileSync("tar", ["-czf", t, "-C", d, "."]);
    expect(scanArtifact(t)).toEqual([]);
    rmSync(t);
  });
  it("fails on a .env even when empty", () => {
    const d = tree({ "pkg/.env": "" });
    expect(scanArtifact(d)).toEqual([{ file: "pkg/.env", reason: "env file" }]);
  });
  it("fails on a token inside a tarball, without echoing it", () => {
    const d = tree({ "lib/x.js": `const k="${fake.ghp}"` });
    const t = join(d, "..", `rg2-${Date.now()}.tgz`);
    execFileSync("tar", ["-czf", t, "-C", d, "."]);
    const f = scanArtifact(t);
    rmSync(t);
    expect(f).toHaveLength(1);
    expect(JSON.stringify(f)).not.toContain(fake.ghp);
    expect(f[0].reason).toContain("github token");
  });
});
