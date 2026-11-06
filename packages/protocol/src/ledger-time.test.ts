import { describe, expect, it } from "vitest";
import { ledgerTimeIso, parseLedgerTime } from "./ledger-time.js";

describe("ledger time (run under TZ=America/Los_Angeles)", () => {
  it("reads the zone-less form as UTC", () => {
    expect(ledgerTimeIso("2026-11-06 00:49")).toBe("2026-11-06T00:49:00Z");
    expect(ledgerTimeIso("2026-11-06 00:49:30")).toBe("2026-11-06T00:49:30Z");
    expect(parseLedgerTime("2026-11-06 00:49")).toBe(Date.UTC(2026, 10, 6, 0, 49));
  });
  it("leaves ISO and junk alone", () => {
    expect(parseLedgerTime("2026-11-05T22:56:00.000Z")).toBe(Date.UTC(2026, 10, 5, 22, 56));
    expect(ledgerTimeIso("nope")).toBe("nope");
    expect(parseLedgerTime("nope")).toBeNaN();
  });
  it("mixed forms order correctly", () => {
    expect(parseLedgerTime("2026-11-06 00:49")).toBeGreaterThan(parseLedgerTime("2026-11-05T22:56:00.000Z"));
  });
});
