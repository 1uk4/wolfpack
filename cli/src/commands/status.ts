import { findWolf, loadWolves, sshRun, type Wolf } from "@wolfpack/core";
import { c, table } from "../render.ts";

type Health = {
  wolf: Wolf;
  reachable: boolean;
  service: string; // active | inactive | failed | unknown
  tmux: boolean;
  since?: string;
  error?: string;
};

// One SSH round-trip per wolf, gathering service + tmux + last-active.
async function probe(wolf: Wolf): Promise<Health> {
  const tmux = wolf.tmuxSocket ? `tmux -L ${wolf.tmuxSocket}` : "tmux";
  const remote = [
    `echo "SVC=$(systemctl is-active ${wolf.service} 2>/dev/null)"`,
    `echo "TMUX=$(${tmux} has-session -t ${wolf.name} 2>/dev/null && echo yes || echo no)"`,
    `echo "SINCE=$(systemctl show ${wolf.service} -p ActiveEnterTimestamp --value 2>/dev/null)"`,
  ].join("; ");

  const res = await sshRun(wolf, remote);
  if (res.code !== 0) {
    return {
      wolf,
      reachable: false,
      service: "unknown",
      tmux: false,
      error: res.timedOut ? "timeout" : (res.stderr.trim().split("\n").pop() || "unreachable"),
    };
  }

  const get = (k: string) => res.stdout.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim() ?? "";
  return {
    wolf,
    reachable: true,
    service: get("SVC") || "unknown",
    tmux: get("TMUX") === "yes",
    since: get("SINCE") || undefined,
  };
}

export async function statusCommand(name: string | undefined, opts: { json?: boolean }): Promise<void> {
  const all = loadWolves();
  const targets = name ? [findWolf(all, name)].filter(Boolean) as Wolf[] : all;

  if (targets.length === 0) {
    console.log(name ? `Unknown wolf: ${name}. Known: ${all.map((w) => w.name).join(", ")}` : "No wolves in inventory.");
    return;
  }

  const results = await Promise.all(targets.map(probe));

  if (opts.json) {
    process.stdout.write(JSON.stringify(results, null, 2) + "\n");
    return;
  }

  const rows = results.map((h) => {
    const marker = !h.reachable ? c.dim("⚪") : h.service === "active" ? c.green("🟢") : c.red("🔴");
    const svc = !h.reachable ? c.dim(h.error ?? "unreachable") : h.service;
    const tmux = !h.reachable ? c.dim("—") : h.tmux ? c.green("✓") : c.red("✗");
    return [
      `${marker} ${c.bold(h.wolf.name)}`,
      h.wolf.runtime === "pi" ? c.cyan("pi") : "claude",
      svc,
      tmux,
      c.dim(h.since ?? "—"),
    ];
  });

  console.log(table(["WOLF", "RUNTIME", "SERVICE", "TMUX", "SINCE"], rows));
}
