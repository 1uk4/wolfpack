/** Seam: scripts/sign-plan.mjs, the mode selection of dist.mjs and the signature parsing of check-app.mjs (no keychain, no Apple). */
import { expect, it } from "vitest";
// @ts-expect-error plain .mjs without types
import { planBuild, parseSignature, sameEntitlements } from "../scripts/sign-plan.mjs";

const ID = '  1) ABCDEF "Developer ID Application: Acme (TEAM123456)"\n     1 valid identities found\n';
const base = { env: { PATH: "/usr/bin", APPLE_ID: "a@b.c", APPLE_TEAM_ID: "T", APPLE_API_KEY: "k", APPLE_KEYCHAIN_PROFILE: "old" }, identities: ID, probeNotary: () => true, profile: "WOLFPACK_NOTARY" };

it("--sign-only signs without notarizing: no notary probe, no APPLE_* env, notarize=false", () => {
  let probed = false;
  const plan = planBuild({ ...base, args: ["--sign-only"], probeNotary: () => ((probed = true), true) });
  expect(plan.error).toBeUndefined();
  expect(plan.builderArgs).toEqual(["--mac", "--arm64", "--publish", "never", "-c.mac.notarize=false"]);
  expect(plan.env).toEqual({ PATH: "/usr/bin" });
  expect(plan.checkAppFlags).toEqual(["--sign-only"]);
  expect(probed).toBe(false);
});

it("--sign-only fails early without a Developer ID identity, and is refused together with --signed", () => {
  expect(planBuild({ ...base, args: ["--sign-only"], identities: "0 valid identities found" }).error).toMatch(/Developer ID Application/);
  expect(planBuild({ ...base, args: ["--sign-only", "--signed"] }).error).toMatch(/--sign-only/);
});

it("--signed still notarizes through the keychain profile; no flag stays unsigned", () => {
  const signed = planBuild({ ...base, args: ["--signed"] });
  expect(signed.builderArgs).toContain("-c.mac.notarize=true");
  expect(signed.env).toEqual({ PATH: "/usr/bin", APPLE_KEYCHAIN_PROFILE: "WOLFPACK_NOTARY" });
  expect(signed.checkAppFlags).toEqual(["--signed"]);
  expect(planBuild({ ...base, args: ["--signed"], probeNotary: () => false }).error).toMatch(/WOLFPACK_NOTARY/);
  const plain = planBuild({ ...base, args: [] });
  expect(plain.builderArgs).toEqual(["--mac", "--arm64", "--publish", "never", "-c.mac.identity=null", "-c.mac.notarize=false"]);
  expect(plain.checkAppFlags).toEqual([]);
});

it("reads authority, team and hardened runtime from codesign output", () => {
  const dvv = [
    "Executable=/x/Wolfpack Console",
    "CodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1 location=embedded",
    "Authority=Developer ID Application: Acme (TEAM123456)",
    "Authority=Developer ID Certification Authority",
    "Authority=Apple Root CA",
    "TeamIdentifier=TEAM123456",
  ].join("\n");
  expect(parseSignature(dvv)).toEqual({ developerId: true, hardenedRuntime: true, team: "TEAM123456" });
  const adhoc = "CodeDirectory v=20400 flags=0x2(adhoc) hashes=1\nSignature=adhoc\nTeamIdentifier=not set";
  expect(parseSignature(adhoc)).toEqual({ developerId: false, hardenedRuntime: false, team: null });
});

it("compares entitlements by content, not key order", () => {
  expect(sameEntitlements({ a: true, b: true }, { b: true, a: true })).toBe(true);
  expect(sameEntitlements({ a: true }, { a: true, b: true })).toBe(false);
});
