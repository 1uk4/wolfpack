import { describe, expect, it } from "vitest";
import { claudeChildEnv } from "./claude-agent-sdk.js";

describe("claudeChildEnv", () => {
  it("never hands API credentials to the claude child (it would bill the API instead of Max)", () => {
    const env = claudeChildEnv({
      ANTHROPIC_API_KEY: "sk-ant-x",
      ANTHROPIC_AUTH_TOKEN: "t",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
      HOME: "/home/wolf",
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth");
    expect(env.HOME).toBe("/home/wolf");
    expect(env.DISABLE_AUTO_COMPACT).toBe("1");
  });
});
