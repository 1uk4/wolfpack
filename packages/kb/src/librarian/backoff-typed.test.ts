import { describe, it, expect } from "vitest";
import { LlmInfraError, OutputTruncatedError } from "@wolfpack/engine";
import { classifyError, shouldParkNow } from "./backoff.js";

describe("classifyError with typed adapter errors", () => {
  it("LlmInfraError is infra (incl. wrapped in a cause chain)", () => {
    expect(classifyError(new LlmInfraError("anything"))).toBe("infra");
    expect(classifyError(new Error("outer", { cause: new LlmInfraError("x") }))).toBe("infra");
  });
  it("OutputTruncatedError is an item error that parks now", () => {
    const e = new OutputTruncatedError("m", 16000, 13000);
    expect(classifyError(e)).toBe("item");
    expect(shouldParkNow(e)).toBe(true);
    expect(shouldParkNow(new Error("x", { cause: e }))).toBe(true);
    expect(shouldParkNow(new Error("plain"))).toBe(false);
  });
  it("error_max_turns-style failures are item errors", () => {
    expect(classifyError(new Error("Failed to extract valid output after 3 attempts. Last error: claude-agent-sdk query failed (error_max_turns)"))).toBe("item");
  });
  it("recognises raw usage-limit and login messages as infra", () => {
    expect(classifyError(new Error("Claude AI usage limit reached|1760000000"))).toBe("infra");
    expect(classifyError(new Error("You've hit your limit · resets 5pm"))).toBe("infra");
    expect(classifyError(new Error("Please run /login"))).toBe("infra");
  });
});
