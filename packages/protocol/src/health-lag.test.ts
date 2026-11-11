import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { machineName, normaliseMachine, stampedVersion, subscriptionFile } from "./health-lag.js";

describe("subscriptionFile", () => {
  it("WOLFPACK_SUBSCRIPTION_FILE wins; a Mac uses ~/.wolfpack/release-channel.json; other hosts use the sfo-01 path", () => {
    expect(subscriptionFile({ WOLFPACK_SUBSCRIPTION_FILE: " /x/s.json " }, "darwin", "/Users/me")).toBe("/x/s.json");
    expect(subscriptionFile({}, "darwin", "/Users/me")).toBe("/Users/me/.wolfpack/release-channel.json");
    expect(subscriptionFile({}, "linux", "/home/me")).toBe("/var/lib/wolfpack-subscription/subscription.json");
  });
});

describe("normaliseMachine", () => {
  it("lowercases, trims and keeps the first dot-label; rejects anything that is not a hostname label", () => {
    expect(normaliseMachine(" SFO-01 ")).toBe("sfo-01");
    expect(normaliseMachine("Lukas-MacBook.local")).toBe("lukas-macbook");
    expect(normaliseMachine("sfo.01")).toBe("sfo");
    expect(normaliseMachine("my_box")).toBeUndefined();
    expect(normaliseMachine("  ")).toBeUndefined();
    expect(normaliseMachine(undefined)).toBeUndefined();
    expect(normaliseMachine("a".repeat(64))).toBeUndefined();
  });
});

describe("machineName", () => {
  it("prefers WOLFPACK_MACHINE, else the OS hostname, lowercased with .local dropped", () => {
    expect(machineName({ WOLFPACK_MACHINE: "  SFO-01 " }, () => "ignored")).toBe("sfo-01");
    expect(machineName({}, () => "Lukas-MacBook.local")).toBe("lukas-macbook");
    expect(machineName({ WOLFPACK_MACHINE: "  " }, () => "Box")).toBe("box");
  });
});

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});
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
