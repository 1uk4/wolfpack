import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAutosquash } from "@wolfpack/workspaces";
import { afterEach, describe, expect, it } from "vitest";
import { readWorkspacesConfig } from "./run.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function yaml(text: string): string {
  const d = mkdtempSync(join(tmpdir(), "wolf-cfg-"));
  dirs.push(d);
  const f = join(d, "wolf.yaml");
  writeFileSync(f, text);
  return f;
}

describe("readWorkspacesConfig", () => {
  it("reads workspaces.autosquash: true, with or without a root", () => {
    expect(resolveAutosquash(readWorkspacesConfig(yaml("workspaces:\n  autosquash: true\n")))).toBe(true);
    const both = readWorkspacesConfig(yaml("workspaces:\n  root: /x\n  autosquash: true\n"));
    expect(both).toEqual({ workspaces: { root: "/x", autosquash: true } });
  });
  it("defaults autosquash to off when absent or not true", () => {
    expect(resolveAutosquash(readWorkspacesConfig(yaml("workspaces:\n  root: /x\n")))).toBe(false);
    expect(resolveAutosquash(readWorkspacesConfig(yaml("workspaces:\n  autosquash: \"yes\"\n")))).toBe(false);
  });
});
