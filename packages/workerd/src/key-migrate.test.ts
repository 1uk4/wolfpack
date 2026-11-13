import { chownSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateKeys } from "./key-migrate.js";

const ANT = "sk-ant-api03-" + "a".repeat(40);
const ANT_OLD = "sk-ant-api03-" + "z".repeat(40);
const DG = "0123456789abcdef0123456789abcdef01234567";
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "mig-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function fixture() {
  const d = tmp();
  const wolfEnv = join(d, "wolf.env");
  const svcEnv = join(d, "svc.env");
  const auth = join(d, "auth.json");
  writeFileSync(wolfEnv, `FOO=1\nANTHROPIC_API_KEY=${ANT}\n`);
  writeFileSync(svcEnv, `DEEPGRAM_API_KEY=${DG}\n`);
  writeFileSync(auth, JSON.stringify({ anthropic: ANT_OLD }));
  return { d, wolfEnv, svcEnv, auth, keyFile: join(d, "keys.env"), marker: join(d, "migrated.json") };
}

describe("key migration", () => {
  it("does nothing unless enabled", () => {
    const f = fixture();
    const r = migrateKeys({ enabled: false, keyFile: f.keyFile, marker: f.marker, wolfEnvFiles: [f.wolfEnv], serviceEnvFiles: [f.svcEnv], authJson: f.auth });
    expect(r).toEqual({ ran: false, copied: [] });
    expect(existsSync(f.keyFile)).toBe(false);
  });

  it("copies once into the key file, only for missing slots, and leaves the sources untouched", () => {
    const f = fixture();
    const before = [f.wolfEnv, f.svcEnv, f.auth].map((p) => readFileSync(p, "utf8"));
    const opts = { enabled: true, keyFile: f.keyFile, marker: f.marker, wolfEnvFiles: [f.wolfEnv], serviceEnvFiles: [f.svcEnv], authJson: f.auth };
    const r = migrateKeys(opts);
    expect(r).toEqual({ ran: true, copied: ["anthropic", "deepgram"] });
    // wolf .env is read first, so its Anthropic key wins over auth.json's
    expect(readFileSync(f.keyFile, "utf8")).toBe(`ANTHROPIC_API_KEY=${ANT}\nDEEPGRAM_API_KEY=${DG}\n`);
    expect([f.wolfEnv, f.svcEnv, f.auth].map((p) => readFileSync(p, "utf8"))).toEqual(before);
    // second run: recorded, so nothing happens even if the Pack file lost a key
    writeFileSync(f.keyFile, "");
    expect(migrateKeys(opts)).toEqual({ ran: false, copied: [] });
    expect(readFileSync(f.keyFile, "utf8")).toBe("");
  });

  it("keeps the key file's group when it rewrites the file", () => {
    const f = fixture();
    const other = (process.getgroups?.() ?? []).find((g) => g !== process.getgid?.());
    if (other === undefined) return; // this user has no second group to observe with
    writeFileSync(f.keyFile, `ANTHROPIC_API_KEY=${ANT_OLD}\n`);
    chownSync(f.keyFile, -1, other);
    migrateKeys({ enabled: true, keyFile: f.keyFile, marker: f.marker, serviceEnvFiles: [f.svcEnv] });
    expect(statSync(f.keyFile).gid).toBe(other);
  });

  it("never overwrites a slot the key file already has", () => {
    const f = fixture();
    writeFileSync(f.keyFile, `ANTHROPIC_API_KEY=${ANT_OLD}\n`);
    const r = migrateKeys({ enabled: true, keyFile: f.keyFile, marker: f.marker, wolfEnvFiles: [f.wolfEnv], serviceEnvFiles: [f.svcEnv] });
    expect(r.copied).toEqual(["deepgram"]);
    expect(readFileSync(f.keyFile, "utf8")).toContain(`ANTHROPIC_API_KEY=${ANT_OLD}`);
  });
});
