import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({ keyHint: () => "" }));
vi.mock("@earendil-works/pi-tui", () => ({
  Box: class {},
  Text: class {},
  truncateToWidth: (s: string) => s,
  visibleWidth: (s: string) => s.length,
}));
vi.mock("typebox", () => {
  const t: any = new Proxy(() => ({}), { get: () => t, apply: () => ({}) });
  return { Type: t };
});
vi.mock("./mux/index.ts", () => ({
  isMuxAvailable: () => true,
  createSurface: vi.fn(),
  isBackgroundSurfaceId: () => false,
  sendCommand: vi.fn(),
  sendLongCommand: vi.fn(),
  pollForExit: vi.fn(),
  probeExit: vi.fn(),
  closeSurface: vi.fn(),
  shellEscape: (s: string) => `'${s}'`,
  readScreen: () => "",
  wolfEnvPrefix: () => "",
}));

import { __test__ } from "./index.ts";
const { childPiModel, getProviderExtensionPaths, applySandboxToParts } = __test__ as any;

const saved = process.env.PI_CODING_AGENT_DIR;
afterEach(() => {
  if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = saved;
});

describe("subagent provider model", () => {
  it("maps canonical and legacy subscription models to the provider a pi child registers", () => {
    expect(childPiModel("claude-stateless/claude-sonnet-5-5")).toBe("claude-bridge/claude-sonnet-5-5");
    expect(childPiModel("claude-bridge/claude-sonnet-5-5")).toBe("claude-bridge/claude-sonnet-5-5");
    expect(childPiModel("anthropic/claude-sonnet-5-5")).toBe("anthropic/claude-sonnet-5-5");
  });

  it("re-enables the provider extension for both ids and passes the child model to --model", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentdir-"));
    process.env.PI_CODING_AGENT_DIR = dir;
    const pkg = join(dir, "npm", "node_modules", "pi-claude-bridge");
    mkdirSync(join(pkg, "src"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ pi: { extensions: ["./src/index.ts"] } }));
    writeFileSync(join(pkg, "src", "index.ts"), "");
    for (const m of ["claude-stateless/claude-haiku-5-5", "claude-bridge/claude-haiku-5-5"]) {
      expect(getProviderExtensionPaths(m)).toEqual([join(pkg, "src", "index.ts")]);
      const parts: string[] = [];
      applySandboxToParts(parts, { model: m, thinking: null, identity: null, toolAllowlist: "read" }, { artifactDir: dir, name: "x" });
      expect(parts.slice(0, 2)).toEqual(["--model", "'claude-bridge/claude-haiku-5-5'"]);
      expect(parts).toContain("--no-extensions");
      expect(parts).toContain("-e");
    }
    expect(getProviderExtensionPaths("anthropic/claude-haiku-5-5")).toEqual([]);
  });
});
