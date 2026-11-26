import { describe, expect, it } from "vitest";
import { mapAppEvent, mapHostStatus, plainError, type HostStatusFile, type UpdateState } from "./update-state.js";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const app = { version: "0.2.0", channel: "stable" as const, now: NOW, host: "this Mac" };
const idle: UpdateState = { target: "app", host: "this Mac", state: "idle", current: "0.2.0", latest: null, progress: null, lastCheck: null, channel: "stable", auto: "on" };

describe("mapAppEvent", () => {
  it("walks the updater events: checking, available, progress 0/50/100, ready, installing", () => {
    const checking = mapAppEvent(idle, { type: "checking" }, app);
    expect(checking).toEqual({ ...idle, state: "checking" });
    const available = mapAppEvent(checking, { type: "available", version: "0.2.1" }, app);
    expect(available).toMatchObject({ state: "available", current: "0.2.0", latest: "0.2.1", progress: null });
    expect(mapAppEvent(available, { type: "progress", percent: 0 }, app)).toMatchObject({ state: "downloading", progress: 0, latest: "0.2.1" });
    expect(mapAppEvent(available, { type: "progress", percent: 50.4 }, app)).toMatchObject({ state: "downloading", progress: 50 });
    expect(mapAppEvent(available, { type: "progress", percent: 100 }, app)).toMatchObject({ state: "downloading", progress: 100 });
    const ready = mapAppEvent(available, { type: "downloaded", version: "0.2.1" }, app);
    expect(ready).toMatchObject({ state: "ready", latest: "0.2.1", progress: 100 });
    expect(mapAppEvent(ready, { type: "installing" }, app)).toMatchObject({ state: "installing", latest: "0.2.1" });
  });

  it("not-available is idle with the check time recorded", () => {
    expect(mapAppEvent({ ...idle, state: "checking" }, { type: "not-available" }, app)).toEqual({ ...idle, state: "idle", latest: "0.2.0", lastCheck: "2026-11-09T12:00:00.000Z" });
  });

  it("an error becomes failed with a plain message and keeps the versions", () => {
    const s = mapAppEvent({ ...idle, state: "checking" }, { type: "error", message: "net::ERR_INTERNET_DISCONNECTED at https://github.com/x/latest-mac.yml" }, app);
    expect(s).toMatchObject({ state: "failed", current: "0.2.0", error: { code: "offline", message: "Couldn't reach the update server. Check your internet connection and try again.", retryable: true } });
  });
});

const unit = (component: string, state: string, extra: object = {}) => ({ component, current: "0.1.18", target: "0.1.19", state, ...extra });
const file = (units: Record<string, object>, extra: Partial<HostStatusFile> = {}): HostStatusFile => ({ host: "sfo-01", enabled: true, lastCheck: "2026-11-09T11:55:00.000Z", units, ...extra }) as HostStatusFile;
const ctx = { now: NOW, channel: "main" as const };

describe("mapHostStatus", () => {
  it("undefined when no unit belongs to the component", () => {
    expect(mapHostStatus(file({ hubd: unit("hubd", "idle") }), "console", ctx)).toBeUndefined();
  });

  it("idle with a newer target is available; idle at target is idle; updating is installing; updated is updated", () => {
    expect(mapHostStatus(file({ console: unit("console", "idle") }), "console", ctx)).toEqual({
      target: "pack", host: "sfo-01", component: "console", state: "available", current: "0.1.18", latest: "0.1.19", progress: null, lastCheck: "2026-11-09T11:55:00.000Z", channel: "main", auto: "on",
    });
    expect(mapHostStatus(file({ console: unit("console", "idle", { target: "0.1.18" }) }), "console", ctx)).toMatchObject({ state: "idle", latest: "0.1.18" });
    expect(mapHostStatus(file({ console: unit("console", "updating") }), "console", ctx)?.state).toBe("installing");
    expect(mapHostStatus(file({ console: unit("console", "updated") }), "console", ctx)?.state).toBe("updated");
  });

  it("failed carries a plain error from the host code", () => {
    const s = mapHostStatus(file({ "workerd-wolves": unit("workerd", "failed", { code: "unhealthy", message: "/healthz on 127.0.0.1:7143: ECONNREFUSED" }) }), "workerd", ctx);
    expect(s).toMatchObject({ state: "failed", unit: "workerd-wolves", error: { code: "unhealthy", message: "The update installed but the service did not start healthy, so it was left as it is.", retryable: false } });
  });

  it("a kill switch is paused with auto off; any other enabled:false is manual", () => {
    const killed = file({ console: unit("console", "disabled") }, { disabledReason: "kill switch: /var/lib/x/auto-update.disabled exists" });
    expect(mapHostStatus(killed, "console", ctx)).toMatchObject({ state: "paused", auto: "off" });
    const manual = file({ console: unit("console", "disabled") }, { enabled: false, disabledReason: "mode is button: the timer installs nothing" });
    expect(mapHostStatus(manual, "console", ctx)).toMatchObject({ state: "manual", auto: "off" });
  });

  it("a manual host is never stale however old; an old check on an auto host is stale, kill switch included", () => {
    const old = "2026-11-09T09:00:00.000Z";
    expect(mapHostStatus(file({ console: unit("console", "idle") }, { enabled: false, lastCheck: old }), "console", ctx)).toMatchObject({ state: "manual", auto: "off" });
    expect(mapHostStatus(file({ console: unit("console", "idle") }, { lastCheck: old }), "console", ctx)).toMatchObject({ state: "stale", auto: "stale" });
    const killed = file({ console: unit("console", "disabled") }, { lastCheck: old, disabledReason: "kill switch: x" });
    expect(mapHostStatus(killed, "console", ctx)).toMatchObject({ state: "paused", auto: "stale" });
  });

  it("with several units the worst one speaks: failed over updating over disabled over updated over idle", () => {
    const units: Record<string, object> = { "wolfd@a": unit("wolfd", "updated"), "wolfd@b": unit("wolfd", "updating"), "wolfd@c": unit("wolfd", "failed", { code: "checksum" }), "wolfd@d": unit("wolfd", "idle") };
    expect(mapHostStatus(file(units), "wolfd", ctx)).toMatchObject({ state: "failed", unit: "wolfd@c" });
    delete units["wolfd@c"];
    expect(mapHostStatus(file(units), "wolfd", ctx)).toMatchObject({ state: "installing", unit: "wolfd@b" });
  });
});

describe("review fixes", () => {
  it("an installing step older than 5 minutes is idle, a fresh one installing", () => {
    expect(mapAppEvent(undefined, { type: "installing", at: NOW - 6 * 60_000 }, app).state).toBe("idle");
    expect(mapAppEvent(undefined, { type: "installing", at: NOW - 60_000 }, app).state).toBe("installing");
  });

  it("a background error is failed and quiet; a user error is not quiet", () => {
    const raw = { type: "error" as const, message: "ERR_INTERNET_DISCONNECTED" };
    expect(mapAppEvent(undefined, { ...raw, background: true }, app).error?.quiet).toBe(true);
    expect(mapAppEvent(undefined, raw, app).error?.quiet).toBeUndefined();
  });

  it("a unit left updating for over 30 minutes is a retryable failure; a recent one is still installing", () => {
    const stale = mapHostStatus(file({ console: unit("console", "updating", { startedAt: new Date(NOW - 31 * 60_000).toISOString() }) }), "console", ctx);
    expect(stale).toMatchObject({ state: "failed", error: { message: "The last update stopped before it finished.", retryable: true } });
    expect(mapHostStatus(file({ console: unit("console", "updating", { startedAt: new Date(NOW - 5 * 60_000).toISOString() }) }), "console", ctx)?.state).toBe("installing");
  });

  it("only a real 404 status is a missing feed, not a port or id containing 404", () => {
    expect(plainError("app", { message: "404 Not Found" }).code).toBe("feed-missing");
    expect(plainError("app", { message: "status 404" }).code).toBe("feed-missing");
    expect(plainError("app", { message: "connect failed localhost:4040" }).code).toBe("unknown");
    expect(plainError("app", { message: "bad id a404b" }).code).toBe("unknown");
    expect(plainError("app", { message: "port 404 refused" }).code).toBe("unknown");
  });
});

describe("plainError", () => {
  const c = { version: "0.2.0" };
  it("offline, missing feed, checksum, rolled back and unknown each get one plain sentence", () => {
    expect(plainError("app", { message: "getaddrinfo ENOTFOUND github.com" }, c)).toEqual({ code: "offline", message: "Couldn't reach the update server. Check your internet connection and try again.", retryable: true });
    expect(plainError("app", { message: 'HttpError: 404 "method: GET url: https://x" Headers: {...}' }, c)).toEqual({ code: "feed-missing", message: "No update is published yet. Wolfpack 0.2.0 is the newest version.", retryable: false });
    expect(plainError("pack", { code: "checksum" }, c)).toEqual({ code: "checksum", message: "The downloaded update did not match its checksum, so it was not installed. Try again later.", retryable: true });
    expect(plainError("pack", { code: "rolled-back" }, c)).toEqual({ code: "rolled-back", message: "The update did not start cleanly, so the previous version was put back.", retryable: false });
    expect(plainError("app", { message: "boom at /Users/me/x.js --flag" }, c)).toEqual({ code: "unknown", message: "The update failed. Try again later, and if it keeps failing check the logs.", retryable: true });
  });
});
