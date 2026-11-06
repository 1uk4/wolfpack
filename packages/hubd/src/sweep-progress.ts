/**
 * Watches `<denLocal>/sweep-current.json` while the hub curator's sweep runs and reports the item in progress when it changes
 * (an item started, or its route became known). Changes are debounced (25 ms), so a burst of writes is reported once, as its last state. The sweep writes that file itself (atomic rename); hubd only observes it, so the
 * sweep's logic is untouched. fs.watch on the directory (a rename replaces the inode, so the file itself cannot be watched) plus a slow
 * re-read as a backstop for platforms where watch events are lost. Every read goes through readSweepCurrent (regular file, no symlink).
 */
import { lstatSync, readdirSync, unlinkSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { readSweepCurrent, type SweepCurrent } from "@wolfpack/kb/librarian";

export const SWEEP_CURRENT_FILE = "sweep-current.json";
const DEBOUNCE_MS = 25;
const BACKSTOP_MS = 1000;

/**
 * Best effort: remove `sweep-current.json.<pid>.tmp` files left by a crashed writer: older than 10 s (by mtime) and not owned by a live pid.
 * The pid is only meaningful in this host's pid namespace (a container or a restored copy of the dir may reuse numbers), hence the age rule.
 */
export function cleanStaleCurrentTmp(denLocal: string, now: number = Date.now()): void {
  try {
    for (const f of readdirSync(denLocal)) {
      const m = /^sweep-current\.json\.(\d+)\.tmp$/.exec(f);
      if (!m) continue;
      const pid = Number(m[1]);
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      const path = join(denLocal, f);
      try {
        if (now - lstatSync(path).mtimeMs < 10_000) continue;
        let alive = pid === process.pid;
        if (!alive) {
          try {
            process.kill(pid, 0);
            alive = true;
          } catch (e) {
            alive = (e as NodeJS.ErrnoException).code !== "ESRCH"; // unknown errors count as alive
          }
        }
        if (!alive) unlinkSync(path);
      } catch {
        /* gone or unreadable */
      }
    }
  } catch {
    /* no dir */
  }
}

/**
 * `since` is epoch ms compared with the `startedAt` the sweep wrote: both come from this process's clock (the hub runs the sweep in
 * process), so no cross-host skew applies; the caller passes a little slack.
 */
export function watchSweepProgress(denLocal: string, onChange: (c: SweepCurrent) => void, since = 0): () => void {
  cleanStaleCurrentTmp(denLocal);
  let last = "";
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    timer = undefined;
    if (closed) return;
    const c = readSweepCurrent(denLocal);
    if (!c || c.startedAt < since) return; // a file left by an earlier (crashed) sweep is not this sweep's item
    const key = `${c.from}\0${c.denTopicId}\0${c.startedAt}\0${c.route ?? ""}`;
    if (key === last) return;
    last = key;
    try {
      onChange(c);
    } catch {
      /* a bad subscriber never breaks the sweep */
    }
  };
  const soon = () => {
    if (!closed && !timer) timer = setTimeout(check, DEBOUNCE_MS);
  };
  let w: FSWatcher | undefined;
  try {
    w = watch(denLocal, (_ev, name) => {
      if (name === null || name === undefined || String(name) === SWEEP_CURRENT_FILE) soon();
    });
    w.on("error", () => {
      /* the backstop still runs */
    });
  } catch {
    /* no watch (directory missing, limits): the backstop covers it */
  }
  const backstop = setInterval(check, BACKSTOP_MS);
  backstop.unref();
  soon();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    clearInterval(backstop);
    try {
      w?.close();
    } catch {
      /* already closed */
    }
  };
}
