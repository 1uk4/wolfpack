import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { createAdapter } from "@wolfpack/engine";
// Source imports on purpose: the loader and the registry it fills must be the same module instance.
import { loadPlugins } from "../../../harness/src/plugins.js";
import { PROVIDER_FACTORIES } from "../../../harness/src/providers/index.js";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "claude-subscription-plugin-"));
const plugins = join(tmp, "plugins");
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Bundles the real entry into <plugins>/claude-subscription (the SDK stays external: it is only imported when a query runs). */
beforeAll(async () => {
  const root = join(plugins, "claude-subscription");
  mkdirSync(join(root, "dist"), { recursive: true });
  await build({ entryPoints: [join(pkgDir, "src/index.ts")], outfile: join(root, "dist/index.js"), bundle: true, format: "esm", platform: "node", target: "node22", external: ["@anthropic-ai/claude-agent-sdk"], logLevel: "silent",
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } });
  const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).wolfpack;
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "claude-subscription", wolfpack: manifest }));
}, 120_000);

describe("claude-subscription plug-in", () => {
  it("registers its chat provider and engine adapter under claude-subscription", async () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: "x", CLAUDE_CODE_PATH: "/u/bin/claude", WOLF_DEN: join(tmp, "home", "den") };
    await loadPlugins({ enabled: ["claude-subscription"], dir: plugins, env });
    const handle = PROVIDER_FACTORIES["claude-subscription"]!({ cwd: tmp, env }) as any;
    expect(handle.provider.id ?? "claude-subscription").toBe("claude-subscription");
    expect(typeof handle.dispose).toBe("function");
    expect((createAdapter({ provider: "claude-subscription", defaultModel: "m" } as any) as any).constructor.name).toBe("ClaudeAgentSdkAdapter");
  }, 60_000);

  it("a missing CLAUDE_CODE_OAUTH_TOKEN stops the load with a message naming the plug-in", async () => {
    await expect(loadPlugins({ enabled: ["claude-subscription"], dir: plugins, env: { CLAUDE_CODE_PATH: "/u/bin/claude" } }))
      .rejects.toThrow("Plug-in claude-subscription needs CLAUDE_CODE_OAUTH_TOKEN; set it and restart.");
  });
});
