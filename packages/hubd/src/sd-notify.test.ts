/**
 * systemd notify (READY / WATCHDOG) at the startSdNotify seam. `send` is the system boundary (systemd-notify in production).
 * No test for the real systemd-notify sender: system boundary (needs a systemd manager; RUNBOOK "Notify/watchdog deploy" checks it live).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { startSdNotify, type SdNotifier } from "./sd-notify.js";

const started: SdNotifier[] = [];
afterEach(() => {
  started.splice(0).forEach((n) => n.stop());
  vi.useRealTimers();
});

function start(env: NodeJS.ProcessEnv) {
  const sent: string[] = [];
  started.push(startSdNotify({ env, pid: 4242, send: (state) => void sent.push(state) }));
  return sent;
}
const systemd = { NOTIFY_SOCKET: "/run/systemd/notify", WATCHDOG_USEC: "100000" }; // WatchdogSec=0.1s -> ping every 50 ms

describe("startSdNotify", () => {
  it("sends nothing when NOTIFY_SOCKET is unset (Mac, tests), even with WATCHDOG_USEC set", () => {
    vi.useFakeTimers();
    const sent = start({ WATCHDOG_USEC: "100000" });
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([]);
  });

  it("sends READY=1 once on start, then WATCHDOG=1 every half WATCHDOG_USEC", () => {
    vi.useFakeTimers();
    const sent = start(systemd);
    expect(sent).toEqual(["READY=1"]);
    vi.advanceTimersByTime(260);
    expect(sent).toEqual(["READY=1", "WATCHDOG=1", "WATCHDOG=1", "WATCHDOG=1", "WATCHDOG=1", "WATCHDOG=1"]);
  });

  it("sends READY=1 but no WATCHDOG=1 when WATCHDOG_PID is another process or WATCHDOG_USEC is missing or invalid", () => {
    vi.useFakeTimers();
    const otherPid = start({ ...systemd, WATCHDOG_PID: "999" }); // ours is 4242
    const noUsec = start({ NOTIFY_SOCKET: "/run/systemd/notify" });
    const badUsec = start({ NOTIFY_SOCKET: "/run/systemd/notify", WATCHDOG_USEC: "soon" });
    vi.advanceTimersByTime(1000);
    expect(otherPid).toEqual(["READY=1"]);
    expect(noUsec).toEqual(["READY=1"]);
    expect(badUsec).toEqual(["READY=1"]);
  });

  it("sends no WATCHDOG=1 while the main event loop is blocked", async () => {
    const sent = start(systemd);
    await new Promise((r) => setTimeout(r, 200)); // the timer is running: pings arrive while the loop is free
    const before = sent.length;
    expect(before).toBeGreaterThanOrEqual(1);
    const until = Date.now() + 500; // 10 intervals of blocked loop
    while (Date.now() < until) {
      /* busy: a frozen hub */
    }
    expect(sent.length).toBe(before);
  });
});
