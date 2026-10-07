/**
 * Herdr MuxBackend — drives panes through the `herdr` CLI. Subagent panes are
 * stacked vertically in a column on the right of the calling pi pane, created
 * with `--no-focus` so they never steal the user's keyboard. Panes are Herdr
 * ids (e.g. `w1:p3`).
 *
 * Layout policy (the "right column"):
 *   - The FIRST live subagent opens as a right split off the pi pane
 *     (`--current`, resolved via $HERDR_PANE_ID) — it owns the whole right
 *     column.
 *   - Each ADDITIONAL subagent splits the currently TALLEST live subagent pane
 *     downward, then the whole column is rebalanced to EVEN heights (see
 *     rebalanceColumn). Splitting the tallest pane keeps any single pane from
 *     being squeezed until it is unusable — so a long-lived top subagent can't
 *     leave later spawns "stuck" with no room — and the rebalance makes the
 *     stack evenly divided no matter the split order.
 *   - When a subagent finishes its pane is closed and dropped from the live
 *     set; Herdr reflows the survivors to reclaim the space. The next spawn
 *     re-evaluates the tallest remaining pane (or reopens the column off pi if
 *     none are left), so the anchor is always a live pane.
 *
 * The live set is tracked in-process (`liveColumn`): createSurface adds, and
 * closeSurface removes. The engine calls closeSurface on every exit path
 * (success, error, cancel), so the set stays accurate. createSurface is
 * synchronous (execFileSync), so parallel spawns update the set without racing.
 *
 * Herdr distinguishes "pane" (raw terminal) from "agent" (a recognized coding
 * agent). We deliberately use only the `pane` verbs: the subagent is launched
 * as a shell command and its completion is detected via file sidecars + a
 * terminal sentinel, exactly like the tmux path — so Herdr's agent recognition
 * is unnecessary.
 *
 * `pane read --source visible` returns the rendered viewport as PLAIN TEXT
 * (not JSON); `recent`/`recent-unwrapped` can be empty when nothing has
 * scrolled into host scrollback, so `visible` is the reliable sentinel source
 * for print-mode (non-alt-screen) children.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { type MuxBackend, hasCommand } from "./shared.ts";

const execFileAsync = promisify(execFile);

function isHerdrAvailable(): boolean {
  return process.env.HERDR_ENV === "1" && hasCommand("herdr");
}

function requireHerdr(): void {
  if (!isHerdrAvailable()) throw new Error(`Herdr is required for subagents. ${herdrBackend.setupHint()}`);
}

/** Parse `herdr pane split` JSON → new pane id. */
function parsePaneId(stdout: string): string {
  const data = JSON.parse(stdout);
  const id = data?.result?.pane?.pane_id;
  if (typeof id !== "string" || !id) {
    throw new Error(`Unexpected herdr pane split output: ${stdout.slice(0, 200)}`);
  }
  return id;
}

/**
 * Live subagent panes in this process, in creation order. The pi pane is never
 * a member. New subagent panes stack vertically beneath an existing one; see
 * the file header for the layout policy.
 */
const liveColumn = new Set<string>();

/** Read per-pane heights from `herdr pane layout` (best-effort, never throws). */
function readPaneHeights(): Map<string, number> {
  const heights = new Map<string, number>();
  try {
    const out = execFileSync("herdr", ["pane", "layout", "--current"], { encoding: "utf8" });
    const panes = JSON.parse(out)?.result?.layout?.panes;
    if (Array.isArray(panes)) {
      for (const p of panes) {
        const id = p?.pane_id;
        const h = p?.rect?.height;
        if (typeof id === "string" && typeof h === "number") heights.set(id, h);
      }
    }
  } catch {
    // layout is advisory; fall back to insertion order below
  }
  return heights;
}

/**
 * Pick the live subagent pane with the most vertical room to split downward.
 * Falls back to the most recently created live pane when layout heights are
 * unavailable. Returns undefined when there are no live subagent panes.
 */
function tallestLivePane(): string | undefined {
  if (liveColumn.size === 0) return undefined;
  const heights = readPaneHeights();
  let best: string | undefined;
  let bestHeight = -1;
  for (const id of liveColumn) {
    const h = heights.get(id) ?? 0;
    if (h > bestHeight) {
      bestHeight = h;
      best = id;
    }
  }
  // If layout gave us nothing, fall back to the last-created live pane.
  if (!best || bestHeight <= 0) {
    for (const id of liveColumn) best = id; // Set preserves insertion order
  }
  return best;
}

/** Run a split and return the new pane id. */
function splitPane(target: { current: true } | { pane: string }, direction: "right" | "down"): string {
  const args = ["pane", "split"];
  if ("current" in target) args.push("--current");
  else args.push("--pane", target.pane);
  args.push("--direction", direction, "--cwd", process.cwd(), "--no-focus");
  return parsePaneId(execFileSync("herdr", args, { encoding: "utf8" }));
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface LayoutPane {
  pane_id: string;
  rect: Rect;
}
interface LayoutSplit {
  direction: "right" | "down";
  ratio: number;
  rect: Rect;
}

/** Read the full column layout (panes + splits). Best-effort; never throws. */
function readLayout(): { panes: LayoutPane[]; splits: LayoutSplit[] } {
  try {
    const out = execFileSync("herdr", ["pane", "layout", "--current"], { encoding: "utf8" });
    const layout = JSON.parse(out)?.result?.layout;
    const panes = Array.isArray(layout?.panes) ? (layout.panes as LayoutPane[]) : [];
    const splits = Array.isArray(layout?.splits) ? (layout.splits as LayoutSplit[]) : [];
    return { panes, splits };
  } catch {
    return { panes: [], splits: [] };
  }
}

/**
 * Rebalance the right column to even pane heights.
 *
 * Each vertical ("down") divider independently controls the ratio between the
 * panes above it and the panes below it, and scales each side proportionally
 * (so equal panes stay equal). So for an even stack we set EVERY divider's
 * ratio to (panes above it) / (panes in its region). Those ratios compose to
 * perfectly even leaf heights regardless of the split order. We target a
 * divider via the pane directly above it (`resize --pane P --direction down`
 * moves the divider just below P; amount is the ratio delta). Best-effort —
 * any failure leaves the current (already usable) layout untouched.
 */
function rebalanceColumn(): void {
  const { panes, splits } = readLayout();
  if (panes.length === 0) return;
  // The subagent column is the rightmost pane group; pi sits to its left.
  const columnX = Math.max(...panes.map((p) => p.rect.x));
  const col = panes.filter((p) => p.rect.x === columnX).sort((a, b) => a.rect.y - b.rect.y);
  if (col.length < 2) return;

  const centerY = (p: LayoutPane) => p.rect.y + p.rect.height / 2;
  const downSplits = splits.filter((s) => s.direction === "down" && s.rect.x === columnX);

  // Compute all (pane, direction, amount) ops from a single snapshot: divider
  // ratios are scale-invariant, so applying one op doesn't invalidate another.
  const ops: Array<{ pane: string; direction: "up" | "down"; amount: number }> = [];
  for (const s of downSplits) {
    const top = s.rect.y;
    const bottom = s.rect.y + s.rect.height;
    const dividerY = s.rect.y + s.ratio * s.rect.height;
    const inRegion = col.filter((p) => centerY(p) >= top - 0.5 && centerY(p) <= bottom + 0.5);
    const above = inRegion.filter((p) => centerY(p) < dividerY);
    const below = inRegion.filter((p) => centerY(p) >= dividerY);
    if (above.length === 0 || below.length === 0) continue;
    const target = above.length / (above.length + below.length);
    const delta = target - s.ratio;
    if (Math.abs(delta) < 0.01) continue;
    // Pane directly above the divider = bottom-most leaf of the top region.
    const anchor = above.reduce((lo, p) => (p.rect.y > lo.rect.y ? p : lo));
    ops.push({ pane: anchor.pane_id, direction: delta > 0 ? "down" : "up", amount: Math.abs(delta) });
  }

  for (const op of ops) {
    try {
      execFileSync(
        "herdr",
        ["pane", "resize", "--pane", op.pane, "--direction", op.direction, "--amount", op.amount.toFixed(4)],
        { encoding: "utf8", stdio: "ignore" },
      );
    } catch {
      // best-effort; skip this divider
    }
  }
}

export const herdrBackend: MuxBackend = {
  name: "herdr",

  isAvailable: isHerdrAvailable,

  setupHint() {
    return "Run pi inside a Herdr-managed pane (HERDR_ENV=1).";
  },

  createSurface(name: string): string {
    requireHerdr();
    const anchor = tallestLivePane();
    let pane: string;
    if (anchor) {
      // Stack beneath an existing subagent pane: grow the column downward.
      try {
        pane = splitPane({ pane: anchor }, "down");
      } catch {
        // Anchor too small to split (or gone): fall back to a fresh right
        // column off pi so a spawn never hard-fails ("can't get stuck").
        pane = splitPane({ current: true }, "right");
      }
    } else {
      // First subagent: open the right column off the pi pane.
      pane = splitPane({ current: true }, "right");
    }
    liveColumn.add(pane);
    // Even out the stack now that a pane has been added.
    rebalanceColumn();
    // Best-effort: label the pane with the subagent name for a nicer sidebar.
    if (name) {
      try {
        execFileSync("herdr", ["pane", "rename", pane, name], { encoding: "utf8", stdio: "ignore" });
      } catch {
        // cosmetic only
      }
    }
    return pane;
  },

  sendCommand(surface: string, command: string): void {
    requireHerdr();
    // `herdr pane run` atomically sends the command text + Enter.
    execFileSync("herdr", ["pane", "run", surface, command], { encoding: "utf8" });
  },

  readScreen(surface: string, lines = 50): string {
    requireHerdr();
    return execFileSync(
      "herdr",
      ["pane", "read", surface, "--source", "visible", "--lines", String(Math.max(1, lines))],
      { encoding: "utf8" },
    );
  },

  async readScreenAsync(surface: string, lines = 50): Promise<string> {
    requireHerdr();
    const { stdout } = await execFileAsync(
      "herdr",
      ["pane", "read", surface, "--source", "visible", "--lines", String(Math.max(1, lines))],
      { encoding: "utf8" },
    );
    return stdout;
  },

  closeSurface(surface: string): void {
    requireHerdr();
    liveColumn.delete(surface);
    execFileSync("herdr", ["pane", "close", surface], { encoding: "utf8" });
    // Herdr reflows the survivors; re-even their heights.
    if (liveColumn.size >= 2) rebalanceColumn();
  },
};
