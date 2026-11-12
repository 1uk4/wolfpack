/** Seam: consoleEnv (electron/console-env.cjs), the env the app gives its console child when it runs its own runtime. */
import { createRequire } from "node:module";
import { expect, it } from "vitest";

const { consoleEnv } = createRequire(import.meta.url)("./console-env.cjs");

it("keeps off-Mac settings and secrets from the owner's shell out of the console env", () => {
  const env = consoleEnv(
    { PATH: "/usr/bin", HOME: "/Users/a", LC_ALL: "C", WOLFPACK_HUB_URL: "https://hub.example", WOLFPACK_HUB_TOKEN: "t", ANTHROPIC_API_KEY: "sk-x", GITHUB_TOKEN: "g", HTTPS_PROXY: "http://proxy:3128" },
    { PORT: "4000", WOLFPACK_API_URL: "http://127.0.0.1:5000" },
  );
  expect(Object.keys(env).sort()).toEqual(["ELECTRON_RUN_AS_NODE", "HOME", "HOSTNAME", "LC_ALL", "NODE_ENV", "PATH", "PORT", "WOLFPACK_API_URL", "WOLFPACK_HUB_RELAY"]);
  expect(env.WOLFPACK_HUB_RELAY).toBe("0");
  expect(env.HOSTNAME).toBe("127.0.0.1");
});
