import { describe, expect, it } from "vitest";
import { generateMachineKeyPair, keyFingerprint, seal, supportsX25519, unseal } from "./seal.js";

const ctx = { hostId: "mac-1", cmdId: "c-abc", slot: "anthropic" };

describe("seal", () => {
  it("round-trips a key and carries issuedAt", async () => {
    const m = await generateMachineKeyPair();
    const sealed = await seal(m.publicKey, { ...ctx, key: "sk-ant-secret-value", issuedAt: 1_700_000_000_000 });
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain("secret");
    expect(await unseal(m.privateKeyPkcs8, sealed, ctx)).toEqual({ key: "sk-ant-secret-value", issuedAt: 1_700_000_000_000 });
  });

  it("refuses a seal opened for another host, command or slot (AAD mismatch)", async () => {
    const m = await generateMachineKeyPair();
    const sealed = await seal(m.publicKey, { ...ctx, key: "k", issuedAt: 1 });
    for (const bad of [{ ...ctx, hostId: "other" }, { ...ctx, cmdId: "c-zzz" }, { ...ctx, slot: "deepgram" }]) {
      await expect(unseal(m.privateKeyPkcs8, sealed, bad)).rejects.toThrow();
    }
  });

  it("refuses a seal made for a different machine key, and garbage", async () => {
    const a = await generateMachineKeyPair();
    const b = await generateMachineKeyPair();
    const sealed = await seal(a.publicKey, { ...ctx, key: "k", issuedAt: 1 });
    await expect(unseal(b.privateKeyPkcs8, sealed, ctx)).rejects.toThrow();
    await expect(unseal(a.privateKeyPkcs8, "v1.not-base64-json", ctx)).rejects.toThrow();
  });

  it("fingerprints a public key as a stable 16 hex string", async () => {
    // sha256 of 32 zero bytes starts 66687aadf862bd77
    expect(await keyFingerprint("A".repeat(43))).toBe("66687aadf862bd77");
  });

  it("detects X25519 support", async () => {
    expect(await supportsX25519()).toBe(true);
  });
});
