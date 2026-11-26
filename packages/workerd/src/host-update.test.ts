/** The host updater's status file as workerd reports it. A real temp file; the clock is injected. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readHostUpdateState } from "./host-update.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const status = (body: unknown) => {
  const d = mkdtempSync(join(tmpdir(), "host-update-"));
  dirs.push(d);
  const f = join(d, "status.json");
  writeFileSync(f, typeof body === "string" ? body : JSON.stringify(body));
  return f;
};

describe("readHostUpdateState", () => {
  it("maps a failed unit to a failed state with a plain reason, and a quiet host to undefined", () => {
    const failed = status({ host: "sfo-01", enabled: true, lastCheck: "2026-11-26T11:55:00.000Z", units: { workerd: { component: "workerd", current: "0.1.9", target: "0.1.10", state: "failed", code: "checksum" } } });
    expect(readHostUpdateState(failed, "stable", NOW)).toMatchObject({ state: "failed", component: "workerd", host: "sfo-01", channel: "stable" });
    const quiet = status({ host: "sfo-01", enabled: true, lastCheck: "2026-11-26T11:55:00.000Z", units: { workerd: { component: "workerd", current: "0.1.10", target: "0.1.10", state: "updated" } } });
    expect(readHostUpdateState(quiet, "stable", NOW)).toBeUndefined();
  });

  it("is undefined for a missing or unreadable file", () => {
    expect(readHostUpdateState("/nonexistent/status.json", "stable", NOW)).toBeUndefined();
    expect(readHostUpdateState(status("{nope"), "stable", NOW)).toBeUndefined();
  });
});
