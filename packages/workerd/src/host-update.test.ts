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
  it("maps a failed unit to a failed state with a plain reason, and a quiet host to its own workerd state", () => {
    const failed = status({ host: "sfo-01", enabled: true, lastCheck: "2026-11-26T11:55:00.000Z", units: { workerd: { component: "workerd", current: "0.1.9", target: "0.1.10", state: "failed", code: "checksum" } } });
    expect(readHostUpdateState(failed, "stable", NOW)).toMatchObject({ state: "failed", component: "workerd", host: "sfo-01", channel: "stable" });
    const quiet = status({ host: "sfo-01", enabled: true, lastCheck: "2026-11-26T11:55:00.000Z", units: { workerd: { component: "workerd", current: "0.1.10", target: "0.1.10", state: "updated" } } });
    expect(readHostUpdateState(quiet, "stable", NOW)).toMatchObject({ state: "updated", component: "workerd", current: "0.1.10", latest: "0.1.10", host: "sfo-01", auto: "on" });
  });

  it("reports an idle host with the target it is heading to, so the card has details and a latest", () => {
    const f = status({ host: "sfo-01", enabled: false, lastCheck: "2026-11-26T11:55:00.000Z", units: { workerd: { component: "workerd", current: "0.1.16-main.4", target: "0.1.16-main.5", state: "idle" } } });
    expect(readHostUpdateState(f, "main", NOW)).toMatchObject({ state: "manual", latest: "0.1.16-main.5", auto: "off", channel: "main", lastCheck: "2026-11-26T11:55:00.000Z" });
  });

  it("a failed unit still wins over a quiet one", () => {
    const f = status({ host: "h", enabled: true, lastCheck: "2026-11-26T11:55:00.000Z", units: { workerd: { component: "workerd", current: "1", target: "1", state: "updated" }, hubd: { component: "hubd", current: "1", target: "2", state: "failed", code: "checksum" } } });
    expect(readHostUpdateState(f, "stable", NOW)).toMatchObject({ state: "failed", component: "hubd" });
  });

  it("is undefined for a missing or unreadable file", () => {
    expect(readHostUpdateState("/nonexistent/status.json", "stable", NOW)).toBeUndefined();
    expect(readHostUpdateState(status("{nope"), "stable", NOW)).toBeUndefined();
  });
});
