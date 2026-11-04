import { describe, expect, it } from "vitest";
import { scanSecrets } from "./secrets.js";

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
