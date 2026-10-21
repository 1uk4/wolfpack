import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isSafeExtensionName, writeDenExtensions } from "./den-extensions.js";

const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("writeDenExtensions", () => {
  let den: string;
  beforeEach(() => { den = fs.mkdtempSync(path.join(os.tmpdir(), "den-ext-")); });
  afterEach(() => fs.rmSync(den, { recursive: true, force: true }));

  const read = (name: string) => fs.readFileSync(path.join(den, "extensions", name, "index.js"), "utf-8");
  const exists = (name: string) => fs.existsSync(path.join(den, "extensions", name));

  it("never deletes an extension the owner put in the den", async () => {
    fs.mkdirSync(path.join(den, "extensions", "mine"), { recursive: true });
    fs.writeFileSync(path.join(den, "extensions", "mine", "index.js"), "owner");

    await writeDenExtensions(den, { bundled: b64("a") });

    expect(read("mine")).toBe("owner");
    expect(read("bundled")).toBe("a");
  });

  it("removes only extensions an earlier sync shipped and no longer ships", async () => {
    await writeDenExtensions(den, { old: b64("1"), kept: b64("2") });
    fs.mkdirSync(path.join(den, "extensions", "mine"), { recursive: true });

    await writeDenExtensions(den, { kept: b64("3") });

    expect(exists("old")).toBe(false);
    expect(read("kept")).toBe("3");
    expect(exists("mine")).toBe(true);
  });

  it("an empty sync still cleans previously shipped extensions", async () => {
    await writeDenExtensions(den, { old: b64("1") });
    await writeDenExtensions(den, {});
    expect(exists("old")).toBe(false);
  });

  it("rejects path-like names", async () => {
    expect(isSafeExtensionName("planner")).toBe(true);
    expect(isSafeExtensionName("../evil")).toBe(false);
    expect(isSafeExtensionName("a/b")).toBe(false);
    await writeDenExtensions(den, { "../evil": b64("x") });
    expect(fs.existsSync(path.join(den, "evil"))).toBe(false);
  });
});
