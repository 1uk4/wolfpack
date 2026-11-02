import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildWolfdSyncBody } from "./wolfd-release.js";

describe("buildWolfdSyncBody (runtime wolfd deploy body)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wolfd-rel-"));
  const tgz = path.join(dir, "wolfd-0.1.0-abc-linux-x64.tar.gz");
  fs.writeFileSync(tgz, "TARBALL-BYTES");

  it("ships the tarball base64 with runtime wolfd, models and env", () => {
    const body = buildWolfdSyncBody(tgz, { modelsJson: "{\"a\":1}", env: { CLAUDE_CODE_OAUTH_TOKEN: "t" } });
    expect(body.runtime).toBe("wolfd");
    expect(Buffer.from(body.tarball, "base64").toString()).toBe("TARBALL-BYTES");
    expect(Buffer.from(body.models!, "base64").toString()).toBe("{\"a\":1}");
    expect(body.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "t" });
  });
  it("omits empty env/models", () => {
    const body = buildWolfdSyncBody(tgz, { env: {} });
    expect(body).not.toHaveProperty("env");
    expect(body).not.toHaveProperty("models");
  });
  it("fails clearly without a release, a missing file or a non-tarball", () => {
    expect(() => buildWolfdSyncBody("")).toThrow(/--release/);
    expect(() => buildWolfdSyncBody(path.join(dir, "nope.tar.gz"))).toThrow(/not found/);
    fs.writeFileSync(path.join(dir, "x.zip"), "z");
    expect(() => buildWolfdSyncBody(path.join(dir, "x.zip"))).toThrow(/tar\.gz/);
  });
});
