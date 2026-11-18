import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seal, unseal } from "@wolfpack/protocol";
import { loadOrCreateMachineKey } from "./machine-key.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "mk-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("machine key", () => {
  it("creates machine-key.pem with mode 0600 on first start and reuses it afterwards", async () => {
    const dir = tmp();
    const a = await loadOrCreateMachineKey(dir);
    const file = join(dir, "machine-key.pem");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain("BEGIN PRIVATE KEY");
    const b = await loadOrCreateMachineKey(dir);
    expect(b.publicKey).toBe(a.publicKey);
    expect(a.publicKey).toHaveLength(43);
  });

  it("opens what the browser seals to its public key", async () => {
    const k = await loadOrCreateMachineKey(tmp());
    const ctx = { hostId: "h1", cmdId: "c-1", slot: "anthropic" };
    const sealed = await seal(k.publicKey, { ...ctx, key: "sk-ant-fake", issuedAt: 5 });
    expect(await unseal(k.privateKeyPkcs8, sealed, ctx)).toEqual({ key: "sk-ant-fake", issuedAt: 5 });
  });

  it("refuses a corrupt key file rather than replacing it", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "machine-key.pem"), "garbage", { mode: 0o600 });
    await expect(loadOrCreateMachineKey(dir)).rejects.toThrow();
  });
});
