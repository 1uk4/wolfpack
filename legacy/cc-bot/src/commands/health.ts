import type { CommandContext, Context } from "grammy";
import { run } from "@wolfpack/core";

// Shape emitted by scripts/wolf-health.sh --json (installed as /usr/local/bin/wolf-health).
// This renders the SAME layout as `wolfpack health` on the host — same rows, same
// columns, same order — so the terminal and Telegram never disagree about what
// the pack looks like. Keep the two renderers in step when either changes.
type WolfRow = {
  name: string;
  unit: string;
  state: string;
  cpu_pct: number;
  mem_bytes: number;
  mem_pct: number;
  tasks: number;
  restarts: number;
  mem_peak_bytes: number;
  tmux: string;
  den: string;
};

type SupportRow = {
  name: string;
  state: string;
  cpu_pct: number;
  mem_bytes: number;
  mem_pct: number;
  tasks: number;
};

type HostHealth = {
  ts: string;
  host: string;
  ncpu: number;
  cpu_pct: number;
  load1: number;
  load5: number;
  load15: number;
  load_per_core: number;
  mem_used: number;
  mem_total: number;
  mem_pct: number;
  mem_avail: number;
  swap_pct: number;
  swap_used: number;
  swap_total: number;
  disk_pct: number;
  disk_used_h: string;
  disk_size_h: string;
  uptime: string;
  wolves: WolfRow[];
  support: SupportRow[];
  status: number; // 0 ok, 1 warning, 2 critical
};

const PROBE = process.env.WOLF_HEALTH_BIN ?? "/usr/local/bin/wolf-health";

function human(bytes: number): string {
  const units = ["B", "K", "M", "G", "T"];
  let b = Math.max(0, bytes);
  let i = 0;
  while (b >= 1024 && i < units.length - 1) {
    b /= 1024;
    i++;
  }
  return i === 0 ? `${b.toFixed(0)}B` : `${b.toFixed(1)}${units[i]}`;
}

// Same ASCII meter the CLI draws — '#' filled, '-' empty, 10 wide.
function bar(pct: number, width = 10): string {
  const clamped = Math.min(100, Math.max(0, pct));
  const filled = Math.round((clamped * width) / 100);
  return "#".repeat(filled) + "-".repeat(width - filled);
}

// The CLI paints severity with ANSI colour, which Telegram cannot show. The
// same thresholds become a leading marker instead, so nothing is lost.
function mark(pct: number, warn: number, crit: number): string {
  if (pct >= crit) return "🔴";
  if (pct >= warn) return "🟡";
  return "🟢";
}

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const lpad = (s: string | number, n: number) => String(s).padStart(n);

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function healthCommand(ctx: CommandContext<Context>): Promise<void> {
  // The probe samples CPU over a 1s window, so allow well past the default timeout.
  const res = await run("sudo", ["-n", PROBE, "--json"], 20_000);

  if (!res.stdout.trim()) {
    await ctx.reply(
      `Health probe returned nothing (exit ${res.code}).\n${res.stderr.trim().slice(0, 300)}`,
    );
    return;
  }

  let h: HostHealth;
  try {
    h = JSON.parse(res.stdout) as HostHealth;
  } catch {
    await ctx.reply(`Could not parse health probe output:\n${res.stdout.slice(0, 300)}`);
    return;
  }

  // <pre> keeps the columns aligned; Telegram's proportional font would not.
  await ctx.reply(`<pre>${esc(renderHealth(h))}</pre>`, { parse_mode: "HTML" });
}

// Exported so the layout can be exercised without a Telegram round-trip.
export function renderHealth(h: HostHealth): string {
  const ts = h.ts.replace("T", " ").slice(0, 19);
  const L: string[] = [];

  L.push(`🐺 WOLFPACK HEALTH  ${h.host}  ${ts}`);
  L.push("─".repeat(76));

  L.push(
    `${mark(h.cpu_pct, 70, 90)} ${pad("CPU", 8)} ${lpad(h.cpu_pct.toFixed(1) + "%", 6)}  [${bar(h.cpu_pct)}]  ${h.ncpu} vCPU`,
  );
  L.push(
    `${mark(h.load_per_core * 100, 100, 150)} ${pad("Load", 8)} ${lpad(h.load_per_core.toFixed(2), 6)}  ${h.load1} / ${h.load5} / ${h.load15}  (1m per core)`,
  );
  L.push(
    `${mark(h.mem_pct, 75, 90)} ${pad("Memory", 8)} ${lpad(h.mem_pct.toFixed(1) + "%", 6)}  [${bar(h.mem_pct)}]  ${human(h.mem_used)} / ${human(h.mem_total)}   avail ${human(h.mem_avail)}`,
  );
  L.push(
    `${mark(h.swap_pct, 25, 60)} ${pad("Swap", 8)} ${lpad(h.swap_pct.toFixed(1) + "%", 6)}  [${bar(h.swap_pct)}]  ${human(h.swap_used)} / ${human(h.swap_total)}`,
  );
  L.push(
    `${mark(h.disk_pct, 80, 90)} ${pad("Disk /", 8)} ${lpad(h.disk_pct + "%", 6)}  [${bar(h.disk_pct)}]  ${h.disk_used_h} / ${h.disk_size_h}`,
  );
  L.push(`   ${pad("Uptime", 8)} ${h.uptime}`);

  L.push("");
  L.push("WOLVES");
  L.push(
    `   ${pad("NAME", 14)} ${pad("STATE", 9)} ${lpad("CPU", 7)} ${lpad("MEM", 10)} ${lpad("%HOST", 7)} ${lpad("TASKS", 6)} ${lpad("RSTRT", 5)} ${lpad("TMUX", 5)} ${lpad("DEN", 5)}`,
  );

  if (h.wolves.length === 0) {
    L.push("   no wolves found on this host");
  }

  for (const w of h.wolves) {
    // systemd can report active while the tmux pane is gone — that is the
    // failure mode /status cannot see, so surface it explicitly.
    const alive = w.state === "active" && w.tmux !== "DOWN";
    L.push(
      `${alive ? "🟢" : "🔴"} ${pad(w.name, 14)} ${pad(w.state, 9)} ${lpad(w.cpu_pct.toFixed(1) + "%", 7)} ${lpad(human(w.mem_bytes), 10)} ${lpad(w.mem_pct.toFixed(1) + "%", 7)} ${lpad(w.tasks, 6)} ${lpad(w.restarts, 5)} ${lpad(w.tmux, 5)} ${lpad(w.den, 5)}`,
    );
    // Restart=always means a crashed wolf is silently back up, having lost its
    // session. Worth saying out loud even when everything reads green now.
    if (w.restarts > 0) {
      L.push(
        `      ^ ${w.restarts} unattended restart(s); peak mem ${human(w.mem_peak_bytes)} of ${human(h.mem_total)}`,
      );
    }
  }

  if (h.support?.length) {
    L.push("");
    L.push(`SUPPORT (competing for the same ${h.ncpu} vCPU)`);
    for (const u of h.support) {
      L.push(
        `   ${pad(u.name, 14)} ${pad(u.state, 9)} ${lpad(u.cpu_pct.toFixed(1), 6)}% ${lpad(human(u.mem_bytes), 10)} ${lpad(u.mem_pct.toFixed(1), 6)}% ${lpad(u.tasks, 6)}`,
      );
    }
  }

  const packMem = h.wolves.reduce((sum, w) => sum + w.mem_bytes, 0);
  const packCpu = h.wolves.reduce((sum, w) => sum + w.cpu_pct, 0);
  L.push("");
  L.push(
    `   Pack total: ${packCpu.toFixed(1)}% CPU, ${human(packMem)} memory (${((packMem / h.mem_total) * 100).toFixed(0)}% of host)`,
  );
  L.push(
    `   status: ${h.status === 2 ? "CRITICAL 🔴" : h.status === 1 ? "WARNING 🟡" : "OK 🟢"}`,
  );

  return L.join("\n");
}
