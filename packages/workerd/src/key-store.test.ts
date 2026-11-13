import { chmodSync, chownSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seal, type CheckResult } from "@wolfpack/protocol";
import { createKeyStore, readKeyPresence } from "./key-store.js";
import { loadOrCreateMachineKey, type MachineKey } from "./machine-key.js";

const ANT = "sk-ant-api03-" + "a".repeat(40);
const ANT2 = "sk-ant-api03-" + "b".repeat(40);
const DG = "0123456789abcdef0123456789abcdef01234567";
const NOW = 1_700_000_000_000;
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "ks-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

async function setup(o: { mode?: number; check?: CheckResult; now?: () => number } = {}) {
  const dir = tmp();
  const mk: MachineKey = await loadOrCreateMachineKey(dir);
  const file = join(dir, "keys.env");
  const checked: string[] = [];
  const restarted: string[] = [];
  const make = () =>
    createKeyStore({
      file,
      seenFile: join(dir, "seen.json"),
      privateKeyPkcs8: mk.privateKeyPkcs8,
      checker: { check: async (_slot: string, v: string) => (checked.push(v), o.check ?? { ok: true }) },
      restartWolvesUsing: async (slot) => {
        const names = slot === "anthropic" ? ["hal", "dewey"] : [];
        restarted.push(...names);
        return names.map((wolf) => ({ wolf, wasActive: true, midReply: false }));
      },
      now: o.now ?? (() => NOW),
      ...(o.mode ? { mode: o.mode } : {}),
    });
  const sealFor = (slot: string, key: string, cmdId: string, issuedAt = NOW, hostId = "box") => seal(mk.publicKey, { hostId, cmdId, slot, key, issuedAt });
  return { dir, file, store: make(), make, sealFor, checked, restarted };
}

describe("key store: set", () => {
  it("writes the key atomically with the configured mode and names the restarted wolves", async () => {
    const t = await setup({ mode: 0o640 });
    const r = await t.store.set({ slot: "anthropic", sealed: await t.sealFor("anthropic", ANT, "c-1"), hostId: "box", cmdId: "c-1" });
    expect(r).toEqual({ ok: true, data: { restarted: [{ wolf: "hal", wasActive: true, midReply: false }, { wolf: "dewey", wasActive: true, midReply: false }] } });
    expect(readFileSync(t.file, "utf8")).toBe(`ANTHROPIC_API_KEY=${ANT}\n`);
    expect(statSync(t.file).mode & 0o777).toBe(0o640);
    expect(readdirSync(t.dir).filter((n) => n.includes("tmp"))).toEqual([]);
  });

  it("defaults the file to mode 0600", async () => {
    const t = await setup();
    await t.store.set({ slot: "deepgram", sealed: await t.sealFor("deepgram", DG, "c-1"), hostId: "box", cmdId: "c-1" });
    expect(statSync(t.file).mode & 0o777).toBe(0o600);
  });

  it("replaces the old key and leaves other slots alone", async () => {
    const t = await setup();
    await t.store.set({ slot: "deepgram", sealed: await t.sealFor("deepgram", DG, "c-1"), hostId: "box", cmdId: "c-1" });
    await t.store.set({ slot: "anthropic", sealed: await t.sealFor("anthropic", ANT, "c-2"), hostId: "box", cmdId: "c-2" });
    await t.store.set({ slot: "anthropic", sealed: await t.sealFor("anthropic", ANT2, "c-3"), hostId: "box", cmdId: "c-3" });
    const text = readFileSync(t.file, "utf8");
    expect(text).toContain(`ANTHROPIC_API_KEY=${ANT2}\n`);
    expect(text).toContain(`DEEPGRAM_API_KEY=${DG}\n`);
    expect(text).not.toContain(ANT + "\n");
  });

  it("keeps the old key and returns the provider's reason when the check rejects", async () => {
    const t = await setup({ check: { ok: false, kind: "rejected", reason: "invalid x-api-key" } });
    writeFileSync(t.file, `ANTHROPIC_API_KEY=${ANT}\n`);
    const r = await t.store.set({ slot: "anthropic", sealed: await t.sealFor("anthropic", ANT2, "c-1"), hostId: "box", cmdId: "c-1" });
    expect(r).toEqual({ ok: false, code: "rejected_key", message: "invalid x-api-key" });
    expect(readFileSync(t.file, "utf8")).toBe(`ANTHROPIC_API_KEY=${ANT}\n`);
    expect(t.restarted).toEqual([]);
  });

  it("refuses a stale issuedAt and says to check the clock", async () => {
    const t = await setup();
    const r = await t.store.set({ slot: "anthropic", sealed: await t.sealFor("anthropic", ANT, "c-1", NOW - 6 * 60_000), hostId: "box", cmdId: "c-1" });
    expect(r).toMatchObject({ ok: false, code: "replay" });
    expect((r as { message: string }).message).toContain("check your clock");
    expect(t.checked).toEqual([]);
  });

  it("refuses a repeated cmdId, also after a restart of the machine", async () => {
    const t = await setup();
    const sealed = await t.sealFor("anthropic", ANT, "c-1");
    expect((await t.store.set({ slot: "anthropic", sealed, hostId: "box", cmdId: "c-1" })).ok).toBe(true);
    expect(await t.store.set({ slot: "anthropic", sealed, hostId: "box", cmdId: "c-1" })).toMatchObject({ ok: false, code: "replay" });
    expect(await t.make().set({ slot: "anthropic", sealed, hostId: "box", cmdId: "c-1" })).toMatchObject({ ok: false, code: "replay" });
  });

  it("answers bad_seal for a seal made for another host, without echoing it", async () => {
    const t = await setup();
    const r = await t.store.set({ slot: "anthropic", sealed: await t.sealFor("anthropic", ANT, "c-1", NOW, "other"), hostId: "box", cmdId: "c-1" });
    expect(r).toMatchObject({ ok: false, code: "bad_seal" });
    expect(JSON.stringify(r)).not.toContain(ANT);
  });

  it("answers store_failed when the file cannot be written, and does not restart wolves", async () => {
    const t = await setup();
    const store = createKeyStore({ file: join(t.dir, "no", "such", "dir", "keys.env"), seenFile: join(t.dir, "seen2.json"), privateKeyPkcs8: (await loadOrCreateMachineKey(t.dir)).privateKeyPkcs8, checker: { check: async () => ({ ok: true }) }, restartWolvesUsing: async () => { t.restarted.push("x"); return []; }, now: () => NOW, createDirs: false });
    const r = await store.set({ slot: "anthropic", sealed: await t.sealFor("anthropic", ANT, "c-9"), hostId: "box", cmdId: "c-9" });
    expect(r).toMatchObject({ ok: false, code: "store_failed" });
    expect(t.restarted).toEqual([]);
  });
});

describe("key store: hardening", () => {
  it("never writes a value that carries a newline or characters a service env file interprets, whatever the checker says", async () => {
    const t = await setup();
    for (const [i, bad] of [ANT + "\nEVIL=1", ANT + "$X", ANT + "#c", ANT + '"q', ANT + "'q", ANT + "\\n"].entries()) {
      const r = await t.store.set({ slot: "anthropic", sealed: await t.sealFor("anthropic", bad, `bad-${i}`), hostId: "box", cmdId: `bad-${i}` });
      expect(r).toMatchObject({ ok: false, code: "rejected_key" });
    }
    expect(existsSync(t.file)).toBe(false);
    expect(t.restarted).toEqual([]);
  });

  it("says the provider could not be reached (not rejected) on a network failure, and keeps the old key", async () => {
    const t = await setup({ check: { ok: false, kind: "network", reason: "timed out" } });
    writeFileSync(t.file, `ANTHROPIC_API_KEY=${ANT}\n`);
    const r = await t.store.set({ slot: "anthropic", sealed: await t.sealFor("anthropic", ANT2, "c-1"), hostId: "box", cmdId: "c-1" });
    expect(r).toMatchObject({ ok: false, code: "check_unreachable" });
    expect((r as { message: string }).message).toMatch(/Couldn't reach Anthropic.*nothing changed/);
    expect(readFileSync(t.file, "utf8")).toBe(`ANTHROPIC_API_KEY=${ANT}\n`);
  });

  it("keeps the file's group across the atomic replace", async () => {
    const t = await setup();
    const other = (process.getgroups?.() ?? []).find((g) => g !== statSync(t.dir).gid && g !== process.getgid?.());
    if (other === undefined) return; // this user has no second group to observe with
    writeFileSync(t.file, `DEEPGRAM_API_KEY=${DG}\n`);
    chownSync(t.file, -1, other);
    await t.store.set({ slot: "anthropic", sealed: await t.sealFor("anthropic", ANT, "c-1"), hostId: "box", cmdId: "c-1" });
    expect(statSync(t.file).gid).toBe(other);
  });

  it("replaces a stale temp file left by a crashed write, with the mode set at creation", async () => {
    const t = await setup({ mode: 0o640 });
    const stale = `${t.file}.${process.pid}.tmp`;
    writeFileSync(stale, "junk");
    chmodSync(stale, 0o666);
    const r = await t.store.set({ slot: "anthropic", sealed: await t.sealFor("anthropic", ANT, "c-1"), hostId: "box", cmdId: "c-1" });
    expect(r.ok).toBe(true);
    expect(statSync(t.file).mode & 0o777).toBe(0o640);
    expect(existsSync(stale)).toBe(false);
  });
});

describe("key store: remove and presence", () => {
  it("does not restart wolves when the slot had no Pack key", async () => {
    const t = await setup();
    writeFileSync(t.file, `DEEPGRAM_API_KEY=${DG}\n`);
    expect(await t.store.remove({ slot: "anthropic" })).toEqual({ ok: true, data: { restarted: [] } });
    expect(t.restarted).toEqual([]);
    expect(readFileSync(t.file, "utf8")).toBe(`DEEPGRAM_API_KEY=${DG}\n`);
  });

  it("reads a key file with CRLF line endings", async () => {
    const t = await setup();
    writeFileSync(t.file, `ANTHROPIC_API_KEY=${ANT}\r\n`);
    expect(readKeyPresence(t.file, {}).find((s) => s.slot === "anthropic")).toMatchObject({ present: true, masked: "••••" + ANT.slice(-4) });
  });

  it("removes only that slot", async () => {
    const t = await setup();
    writeFileSync(t.file, `ANTHROPIC_API_KEY=${ANT}\nDEEPGRAM_API_KEY=${DG}\n`);
    const r = await t.store.remove({ slot: "anthropic" });
    expect(r.ok).toBe(true);
    expect(readFileSync(t.file, "utf8")).toBe(`DEEPGRAM_API_KEY=${DG}\n`);
  });

  it("reports presence per slot with mask, source and shadowing, never the value", async () => {
    const t = await setup();
    writeFileSync(t.file, `ANTHROPIC_API_KEY=${ANT}\n`);
    const p = readKeyPresence(t.file, { ANTHROPIC_API_KEY: ANT2, DEEPGRAM_API_KEY: DG });
    expect(p).toEqual([
      { slot: "anthropic", present: true, masked: "••••" + ANT.slice(-4), source: "pack", shadowsEnv: true },
      { slot: "deepgram", present: true, masked: "••••" + DG.slice(-4), source: "env", shadowsEnv: false },
    ]);
    expect(JSON.stringify(p)).not.toContain(ANT);
    expect(readKeyPresence(t.file, {}).find((s) => s.slot === "anthropic")).toMatchObject({ source: "pack" });
    expect(readKeyPresence(join(t.dir, "none.env"), {})).toEqual([
      { slot: "anthropic", present: false },
      { slot: "deepgram", present: false },
    ]);
  });
});
