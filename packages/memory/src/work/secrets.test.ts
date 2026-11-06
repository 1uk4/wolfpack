import { describe, expect, it } from "vitest";
import { looksSecretForCrawl, scanSecrets, scanSecretsForCrawl } from "./secrets.js";

describe("scanSecrets: telegram bot tokens", () => {
  const tok = `${"1".repeat(9)}:${"A".repeat(10)}-${"b".repeat(10)}_${"c".repeat(13)}`;
  it("redacts a bot token", () => {
    expect(tok.split(":")[1]).toHaveLength(35);
    const r = scanSecrets(`bot ${tok} here`);
    expect(r.text).toBe("bot [REDACTED:telegram bot token] here");
    expect(r.findings).toEqual([{ kind: "telegram bot token", count: 1 }]);
  });
  it("leaves times, ratios and short ids alone", () => {
    expect(scanSecrets("12:30:45 ratio 3:1 id 12345678:short").findings).toEqual([]);
  });
});

describe("scanSecretsForCrawl", () => {
  it("leaves the work-item rule alone: scanSecrets still redacts a work id after 'token:'", () => {
    expect(scanSecrets("token: work-wolfpack-ZBZPAZ9").findings).toEqual([{ kind: "credential assignment", count: 1 }]);
    expect(scanSecretsForCrawl("token: work-wolfpack-ZBZPAZ9").findings).toEqual([]);
  });
  it("exempts ids, env-var names, plain words, paths and placeholders", () => {
    for (const v of ["work-wolfpack-ZBZPAZ9", "kb-wolfpack-4acoMDv", "HUBD_TOKEN", "WOLFPACK_HUB_TOKEN", "per-wolf", "hub-token-file", "~/.wolfpack/hub.json", "/etc/hub/token", "<masked>", "<redacted>", "***", "xxxxxxxx", "${HUB_TOKEN}", "$HUB_TOKEN"]) {
      expect(scanSecretsForCrawl(`token: ${v}`).findings, v).toEqual([]);
    }
  });
  it("still catches near-miss real secrets", () => {
    for (const v of ["a1b2c3d4e5f6a7b8c9d0e1f2", "hunter2hunter2", "Zx9_Qw3-Lk7pR2vT8nB4", "work-wolfpack-ZBZPAZ9-9f8e7d6c5b4a3210", "AB12CD34EF56GH78IJ", "per-wolf-2026-0abc1234def", "kb-wolfpack-4acoMDv.suffix1"]) {
      expect(scanSecretsForCrawl(`secret=${v}`).findings.map((f) => f.kind), v).toContain("credential assignment");
    }
    for (const t of ["sk-" + "a".repeat(24), "-----BEGIN RSA PRIVATE KEY-----\nx", "Bearer " + "a".repeat(30), "https://u:" + "passw0rd@host/x", "ghp_" + "A1".repeat(18)]) expect(scanSecretsForCrawl(t).findings.length, t.slice(0, 8)).toBeGreaterThan(0);
  });
  it("ignores markdown/code punctuation around a value: `apiKey`, apiKey(), **x**, apiKey.value, trailing period", () => {
    for (const v of ["`apiKey`", "apiKey()", "**plaintoken**", "apiKey.value", "someword."]) expect(scanSecretsForCrawl(`token: ${v}`).findings, v).toEqual([]);
    expect(scanSecretsForCrawl("token: `a1b2c3d4e5f6a7b8`").findings.length).toBe(1); // a quoted real key is still caught
  });
  it("the exemptions are bounded: passphrases and long words are caught", () => {
    for (const v of ["correct-horse-battery-staple", "my_secret_phrase", "Sunshinebabyloveforever", "abcdefghijklmnopqrstu", "Zx.Qw.Lk.Pr", "aBcDeFgHiJkLmNoP", "HUBD_WOLF_TOKEN_VALUE_EXTRA_LONG_NAMES_XY_Z", "VERYLONGSEGMENTNAME_TOKEN"]) {
      expect(looksSecretForCrawl(v), v).toBe(true);
    }
  });
  it("short names, identifiers, env vars and real paths still pass", () => {
    for (const v of ["per-wolf", "hub-token-file", "apiKey", "apiKey.value", "getAuthToken", "Sunshine", "HUBD_TOKEN", "~/.wolfpack/hub.json", "/etc/hub/token", "hub.json"]) {
      expect(looksSecretForCrawl(v), v).toBe(false);
    }
  });
});
