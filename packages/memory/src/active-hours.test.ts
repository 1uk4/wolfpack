import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activeHoursSince, recordOwnerMessage } from "./active-hours.js";

const den = () => mkdtempSync(join(tmpdir(), "active-hours-"));

describe("active hours", () => {
  it("records an owner message as its UTC hour key, once per hour, in the agreed file shape", () => {
    const d = den();
    recordOwnerMessage(d, new Date("2026-11-13T09:05:00Z"));
    recordOwnerMessage(d, new Date("2026-11-13T09:55:00Z"));
    recordOwnerMessage(d, new Date("2026-11-13T11:00:00Z"));
    expect(JSON.parse(readFileSync(join(d, "memory", "active-hours.json"), "utf8"))).toEqual({
      version: 1,
      hours: ["2026-11-13T09", "2026-11-13T11"],
    });
  });

  it("prunes hours older than 60 days", () => {
    const d = den();
    mkdirSync(join(d, "memory"), { recursive: true });
    writeFileSync(join(d, "memory", "active-hours.json"), JSON.stringify({ version: 1, hours: ["2026-08-01T10", "2026-11-01T10"] }));
    recordOwnerMessage(d, new Date("2026-11-13T09:00:00Z"));
    expect(JSON.parse(readFileSync(join(d, "memory", "active-hours.json"), "utf8")).hours).toEqual(["2026-11-01T10", "2026-11-13T09"]);
  });

  it("counts only hours the owner was active after a moment: being away does not age a topic", () => {
    const d = den();
    for (const h of ["09", "10", "14"]) recordOwnerMessage(d, new Date(`2026-11-12T${h}:30:00Z`));
    // quiet since 09:30; the active hours after it are 10 and 14, though 20+ wall hours passed
    expect(activeHoursSince(d, new Date("2026-11-12T09:30:00Z"))).toBe(2);
    expect(activeHoursSince(d, new Date("2026-11-12T14:59:00Z"))).toBe(0);
  });
});
