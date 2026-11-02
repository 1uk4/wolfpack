import { describe, expect, it } from "vitest";
import { buildSshArgv, parseReleaseRef, planDeploy } from "./deploy.js";
import { deployCmd } from "./commands/deploy.js";
import type { CliConfig, HostEntry } from "./config.js";

const host: HostEntry = { address: "10.0.0.5", port: 3141, apiKey: "SECRET-API", ssh: { user: "deploy", key: "/k/id", port: 22 } };
const cfg = { defaultHost: "sfo-01", hosts: { "sfo-01": host }, wolvesRoot: "/nonexistent" } as unknown as CliConfig;

describe("parseReleaseRef", () => {
  it("accepts tag, v-version, bare version", () => {
    expect(parseReleaseRef("wolfd/v0.1.1")).toEqual({ component: "wolfd", version: "0.1.1", tag: "wolfd/v0.1.1" });
    expect(parseReleaseRef("v0.1.1", "wolfd").tag).toBe("wolfd/v0.1.1");
    expect(parseReleaseRef("0.2.0", "hubd").tag).toBe("hubd/v0.2.0");
  });
  it("rejects garbage, unknown components, mismatches, bare version without component", () => {
    expect(() => parseReleaseRef("latest", "wolfd")).toThrow(/must be/);
    expect(() => parseReleaseRef("console/v1.0.0")).toThrow(/unknown component/);
    expect(() => parseReleaseRef("hubd/v1.0.0", "wolfd")).toThrow(/hubd tag/);
    expect(() => parseReleaseRef("1.0.0")).toThrow(/component/);
    expect(() => parseReleaseRef("wolfd/v1.0; rm -rf /")).toThrow();
  });
});

describe("planDeploy", () => {
  it("wolf deploy -> wolfd args on the default host", () => {
    const p = planDeploy({ wolf: "hal2", release: "wolfd/v0.1.1" }, { defaultHost: "sfo-01" });
    expect(p).toMatchObject({ host: "sfo-01", component: "wolfd", scriptArgs: ["wolfd", "0.1.1", "--wolf", "hal2"] });
  });
  it("prefers the host that has the wolf; errors when ambiguous; --host wins", () => {
    expect(planDeploy({ wolf: "hal2", release: "0.1.1" }, { defaultHost: "a", hostsWithWolf: ["b"] }).host).toBe("b");
    expect(() => planDeploy({ wolf: "hal2", release: "0.1.1" }, { hostsWithWolf: ["a", "b"] })).toThrow(/several hosts/);
    expect(planDeploy({ wolf: "hal2", release: "0.1.1", host: "z" }, { hostsWithWolf: ["a", "b"] }).host).toBe("z");
  });
  it("host components need --component and no wolf; local is refused; bad wolf names too", () => {
    expect(planDeploy({ component: "hubd", release: "hubd/v0.2.0", host: "h", dryRun: true, healthTimeout: 30 }, {}).scriptArgs)
      .toEqual(["hubd", "0.2.0", "--health-timeout", "30", "--dry-run"]);
    expect(() => planDeploy({ wolf: "hal2", component: "hubd", release: "0.2.0" }, { defaultHost: "h" })).toThrow(/host component/);
    expect(() => planDeploy({ wolf: "hal2", release: "0.1.1" }, {})).toThrow(/remote host/);
    expect(() => planDeploy({ wolf: "Bad;x", release: "0.1.1" }, { defaultHost: "h" })).toThrow(/needs a wolf/);
    expect(() => planDeploy({ wolf: "hal2", release: "0.1.1", healthTimeout: 0 }, { defaultHost: "h" })).toThrow(/health-timeout/);
  });
});

describe("buildSshArgv", () => {
  it("pipes the script to sudo bash -s, key-only", () => {
    const a = buildSshArgv(host, ["wolfd", "0.1.1", "--wolf", "hal2"]);
    expect(a.at(-1)).toBe("sudo bash -s -- wolfd 0.1.1 --wolf hal2");
    expect(a).toContain("deploy@10.0.0.5");
    expect(a).toContain("IdentityAgent=none");
    expect(buildSshArgv({ ...host, ssh: { ...host.ssh, user: "root" } }, ["hubd", "1.0.0"]).at(-1)).toBe("bash -s -- hubd 1.0.0");
    expect(a.join(" ")).not.toContain("SECRET-API");
  });
});

describe("deployCmd (ssh mocked)", () => {
  it("sends the script on stdin and returns the exit code", async () => {
    const calls: { argv: string[]; stdin: string }[] = [];
    const out: string[] = [];
    const code = await deployCmd({ wolf: "hal2", release: "wolfd/v0.1.1", dryRun: true }, {
      config: cfg, log: (s) => out.push(s), readScript: () => "#!/bin/bash\necho hi\n",
      run: async (argv, stdin) => { calls.push({ argv, stdin }); return 0; },
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.stdin).toContain("echo hi");
    expect(calls[0]!.argv.at(-1)).toBe("sudo bash -s -- wolfd 0.1.1 --wolf hal2 --dry-run");
    expect(out.join("\n")).toContain("dry run");
  });
  it("propagates a rollback exit code and rejects unknown hosts without calling ssh", async () => {
    const run = async () => 3;
    expect(await deployCmd({ wolf: "hal2", release: "0.1.1" }, { config: cfg, log: () => {}, readScript: () => "x", run })).toBe(3);
    let called = false;
    await expect(deployCmd({ wolf: "hal2", release: "0.1.1", host: "nope" }, { config: cfg, log: () => {}, readScript: () => "x", run: async () => { called = true; return 0; } })).rejects.toThrow(/not found/);
    expect(called).toBe(false);
  });
});
