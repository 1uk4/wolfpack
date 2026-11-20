import { afterEach, describe, expect, it, vi } from "vitest";
import { createHubHealth } from "./health.js";

/** hubd's own inventory entry says how its curator reaches Claude, never the credential itself. */
describe("hubd self inventory entry: memoryTransport", () => {
  afterEach(() => vi.unstubAllEnvs());
  const selfEntry = (env: Record<string, string>) => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const h = createHubHealth();
    try {
      return h.self();
    } finally {
      h.stop();
    }
  };

  it("reports subscription for an OAuth token, api for an API key, none for neither, and never the secret", () => {
    const sub = selfEntry({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-SECRET" });
    expect(sub.memoryTransport).toBe("subscription");
    expect(JSON.stringify(sub)).not.toContain("SECRET");
    expect(selfEntry({ ANTHROPIC_API_KEY: "sk-ant-api-SECRET" }).memoryTransport).toBe("api");
    expect(selfEntry({}).memoryTransport).toBe("none");
  });
});
