/**
 * systemd notify for hubd (work-wolfpack-94pN3co): READY=1 once the hub listens, then WATCHDOG=1 from a timer on the main event loop
 * every WATCHDOG_USEC / 2. A blocked loop stops the timer, the pings stop, and systemd kills and restarts hubd after WatchdogSec.
 *
 * Node has no unix datagram sockets, so the default sender spawns `systemd-notify <state>`. No --pid: with it, systemd-notify puts a
 * foreign PID in SCM_CREDENTIALS, which an unprivileged sender (user hubd, empty CapabilityBoundingSet) may not do. Under
 * NotifyAccess=all systemd attributes a message by the sender's cgroup, and the spawned child is already in hubd's cgroup.
 * systemd-notify waits until the manager has processed the message (sd_notify_barrier, the default since systemd 246), so it is still
 * alive, and still in the cgroup, when systemd looks it up. No native module.
 *
 * Without NOTIFY_SOCKET (Mac, tests, a hand-started hubd) nothing is sent at all.
 */
import { execFile } from "node:child_process";

export interface SdNotifier {
  /** Stop the watchdog timer (idempotent). */
  stop(): void;
}

export interface SdNotifyOptions {
  env: NodeJS.ProcessEnv;
  /** Sends one notify state line (system boundary). Default: systemd-notify. */
  send?: (state: string) => void;
  /** Our pid, checked against WATCHDOG_PID. Default process.pid. */
  pid?: number;
  log?: (msg: string) => void;
}

const NOOP: SdNotifier = { stop() {} };

/** Call once, after the hub is listening. */
export function startSdNotify(opts: SdNotifyOptions): SdNotifier {
  const { env } = opts;
  if (!env.NOTIFY_SOCKET?.trim()) return NOOP;
  const pid = opts.pid ?? process.pid;
  const log = opts.log ?? ((m: string) => console.error(m));
  const usec = Number(env.WATCHDOG_USEC?.trim());
  const watchdogPid = env.WATCHDOG_PID?.trim();
  // sd_watchdog_enabled semantics: no valid WATCHDOG_USEC, or a WATCHDOG_PID that is not us, means no watchdog for this process.
  const watchdog = Number.isFinite(usec) && usec > 0 && !(watchdogPid && Number(watchdogPid) !== pid);
  const everyMs = Math.max(1, Math.floor(usec / 2000));
  const plan = watchdog ? `watchdog every ${everyMs % 1000 === 0 ? `${everyMs / 1000}s` : `${everyMs}ms`}` : "no watchdog for this process";
  const send = opts.send ?? systemdNotifySender(plan, log);
  send("READY=1");
  if (!watchdog) return NOOP;
  const timer = setInterval(() => send("WATCHDOG=1"), everyMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

/** System boundary: spawns the real systemd-notify. Logs the first success once (proof in the journal) and the first failure once. */
function systemdNotifySender(plan: string, log: (msg: string) => void): (state: string) => void {
  let okLogged = false;
  let warned = false;
  return (state) => {
    execFile("systemd-notify", [state], { timeout: 10_000 }, (err) => {
      if (!err) {
        if (!okLogged) {
          okLogged = true;
          log(`hubd: systemd notify: ${state} sent; ${plan}`);
        }
      } else if (!warned) {
        warned = true; // once: a broken notify path would otherwise log every 15 s until the watchdog restarts us
        log(`hubd: systemd-notify ${state} failed: ${err.message}`);
      }
    });
  };
}
