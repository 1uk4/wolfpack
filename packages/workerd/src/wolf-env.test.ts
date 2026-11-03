import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dotenvValue, wolfEnvHubKb } from "./wolf-env.js";

const tmp: string[] = [];
afterEach(() => { while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true }); });
function home(env?: string) {
  const h = mkdtempSync(join(tmpdir(), "wolf-env-"));
  tmp.push(h);
  mkdirSync(join(h, "wolves", "hal2"), { recursive: true });
  if (env !== undefined) writeFileSync(join(h, ".env"), env);
  return join(h, "wolves", "hal2", "wolf.yaml");
}

describe("wolfEnvHubKb", () => {
  it("true when the wolf's .env sets WOLFPACK_HUB_KB=1 (ancestor home, quotes, export)", () => {
    expect(wolfEnvHubKb(home("A=1\nWOLFPACK_HUB_KB=1\nWOLFPACK_HUB_TOKEN=secret\n"))).toBe(true);
    expect(wolfEnvHubKb(home('export WOLFPACK_HUB_KB="true"\n'))).toBe(true);
  });
  it("false when absent, off, commented, or no .env", () => {
    expect(wolfEnvHubKb(home("A=1\n"))).toBe(false);
    expect(wolfEnvHubKb(home("WOLFPACK_HUB_KB=0\n"))).toBe(false);
    expect(wolfEnvHubKb(home("# WOLFPACK_HUB_KB=1\n"))).toBe(false);
    expect(wolfEnvHubKb(home())).toBe(false);
  });
  it("parser: last wins, unknown key undefined", () => {
    expect(dotenvValue("K=1\nK=2\n", "K")).toBe("2");
    expect(dotenvValue("K=1\n", "X")).toBeUndefined();
  });
});
