/**
 * Watches `<denLocal>/sweep-current.json` while the hub curator's sweep runs and reports each change of the item in progress
 * (an item started, or its route became known). The sweep writes that file itself (atomic rename); hubd only observes it, so the
 * sweep's logic is untouched. fs.watch on the directory (a rename replaces the inode, so the file itself cannot be watched) plus a slow
 * re-read as a backstop for platforms where watch events are lost. Every read goes through readSweepCurrent (regular file, no symlink).
 */
import { watch, type FSWatcher } from "node:fs";
import { readSweepCurrent, type SweepCurrent } from "@wolfpack/kb/librarian";

export const SWEEP_CURRENT_FILE = "sweep-current.json";
const DEBOUNCE_MS = 25;
const BACKSTOP_MS = 1000;

export function watchSweepProgress(denLocal: string, onChange: (c: SweepCurrent) => void, since = 0): () => void {
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
