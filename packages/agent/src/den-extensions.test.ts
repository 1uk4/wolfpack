import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isSafeExtensionName, restoreDenExtensions, snapshotDenExtensions, writeDenExtensions } from "./den-extensions.js";

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

describe("snapshotDenExtensions / restoreDenExtensions", () => {
  let den: string;
  let bak: string;
  beforeEach(() => {
    den = fs.mkdtempSync(path.join(os.tmpdir(), "den-snap-"));
    bak = path.join(den, "..", path.basename(den) + "-bak");
  });
  afterEach(() => { fs.rmSync(den, { recursive: true, force: true }); fs.rmSync(bak, { recursive: true, force: true }); });
  const ext = (n: string) => path.join(den, "extensions", n, "index.js");
  const read = (n: string) => fs.readFileSync(ext(n), "utf-8");
  const sync = async (m: Record<string, string>) => { await snapshotDenExtensions(den, bak, m); await writeDenExtensions(den, m); };

  it("restore with no snapshot returns false and changes nothing", async () => {
    await writeDenExtensions(den, { a: b64("1") });
    expect(await restoreDenExtensions(den, bak)).toBe(false);
    expect(read("a")).toBe("1");
  });

  it("puts back a replaced extension, one the sync removed, and removes one it added", async () => {
    await writeDenExtensions(den, { a: b64("A1"), gone: b64("G1") });
    await sync({ a: b64("A2"), fresh: b64("F2") });
    expect(fs.existsSync(ext("gone"))).toBe(false);
    expect(await restoreDenExtensions(den, bak)).toBe(true);
    expect(read("a")).toBe("A1");
    expect(read("gone")).toBe("G1");
    expect(fs.existsSync(ext("fresh"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(den, "extensions", ".managed.json"), "utf-8")).sort()).toEqual(["a", "gone"]);
    expect(fs.readdirSync(path.join(den, "extensions")).some((n) => n.endsWith(".restoring"))).toBe(false);
  });

  it("a second snapshot replaces the first (it describes the latest sync only)", async () => {
    await sync({ a: b64("A1") });
    await sync({ a: b64("A2") });
    await sync({ a: b64("A3") });
    await restoreDenExtensions(den, bak);
    expect(read("a")).toBe("A2");
  });

  it("a non-ENOENT error while snapshotting is rethrown before anything is replaced", async () => {
    await writeDenExtensions(den, { a: b64("A1") });
    fs.writeFileSync(path.join(den, "extensions", ".managed.json"), "{not json");
    await expect(snapshotDenExtensions(den, bak, { a: b64("A2") })).rejects.toThrow();
    expect(read("a")).toBe("A1");
    // an unreadable extension dir (EACCES) is not "absent" either
    fs.writeFileSync(path.join(den, "extensions", ".managed.json"), JSON.stringify(["a"]));
    fs.chmodSync(path.join(den, "extensions", "a"), 0o000);
    try {
      if (process.getuid?.() !== 0) await expect(snapshotDenExtensions(den, bak, { a: b64("A2") })).rejects.toThrow();
    } finally {
      fs.chmodSync(path.join(den, "extensions", "a"), 0o755);
    }
  });

  it("a malformed snapshot.json throws and leaves the extensions and manifest alone", async () => {
    await writeDenExtensions(den, { a: b64("A1") });
    fs.mkdirSync(bak, { recursive: true });
    for (const bad of ['{"managed":"x","touched":[],"present":[]}', '{"managed":[],"touched":["../evil"],"present":[]}', '{"managed":[],"touched":["a"],"present":["b"]}', "garbage"]) {
      fs.writeFileSync(path.join(bak, "snapshot.json"), bad);
      await expect(restoreDenExtensions(den, bak)).rejects.toThrow();
    }
    expect(read("a")).toBe("A1");
    expect(JSON.parse(fs.readFileSync(path.join(den, "extensions", ".managed.json"), "utf-8"))).toEqual(["a"]);
  });

  it("a copy error during restore leaves the current extensions in place", async () => {
    await writeDenExtensions(den, { a: b64("A1") });
    await sync({ a: b64("A2") });
    fs.rmSync(path.join(bak, "a"), { recursive: true }); // snapshot says present, copy is gone
    await expect(restoreDenExtensions(den, bak)).rejects.toThrow();
    expect(read("a")).toBe("A2");
  });
});
