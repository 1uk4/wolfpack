import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { inventoryPath as defaultInventoryPath, expandHome } from "./paths.ts";

export type WolfRuntime = "claude" | "pi";

export type Wolf = {
  /** wolf_name (also the systemd unit + tmux session name) */
  name: string;
  service: string;
  runtime: WolfRuntime;
  /** inventory group the wolf belongs to */
  group: string;
  /** inventory host key (e.g. "wolf-01") */
  hostKey: string;
  /** ansible_host — public or tailscale IP */
  host?: string;
  /** unix user the wolf runs as on the droplet */
  user: string;
  /** ssh private key file (expanded) */
  keyFile?: string;
  /** raw ansible_ssh_extra_args string, if any */
  sshExtraArgs?: string;
};

type HostEntry = Record<string, unknown> & { wolf_name?: string };
type Group = { vars?: Record<string, unknown>; hosts?: Record<string, HostEntry | null> | null };
type InventoryDoc = { all?: { vars?: Record<string, unknown>; children?: Record<string, Group | undefined> } };

// Inventory groups that hold wolves, and the runtime each group runs.
const WOLF_GROUPS: { group: string; runtime: WolfRuntime }[] = [
  { group: "wolves", runtime: "claude" },
  { group: "pi_wolves", runtime: "pi" },
];

export function loadInventoryDoc(path: string = defaultInventoryPath()): InventoryDoc {
  return parse(readFileSync(path, "utf8")) as InventoryDoc;
}

export function loadWolves(path: string = defaultInventoryPath()): Wolf[] {
  const doc = loadInventoryDoc(path);
  const all = doc.all ?? {};
  const globals = all.vars ?? {};
  const children = all.children ?? {};

  const wolves: Wolf[] = [];
  const seen = new Set<string>();

  for (const { group, runtime } of WOLF_GROUPS) {
    const g = children[group];
    const hosts = g?.hosts;
    if (!hosts) continue;
    const groupVars = g?.vars ?? {};

    for (const [hostKey, rawEntry] of Object.entries(hosts)) {
      const entry = rawEntry ?? {};
      const name = str(entry.wolf_name);
      if (!name || seen.has(name)) continue;
      seen.add(name);

      const user =
        str(entry.wolf_user) ?? str(groupVars.wolf_user) ?? str(globals.wolf_user) ?? "wolf";
      const keyFileRaw = str(entry.ansible_ssh_private_key_file);

      wolves.push({
        name,
        service: `${name}.service`,
        runtime,
        group,
        hostKey,
        host: str(entry.ansible_host),
        user,
        keyFile: keyFileRaw ? expandHome(keyFileRaw) : undefined,
        sshExtraArgs: str(entry.ansible_ssh_extra_args),
      });
    }
  }

  return wolves;
}

export function findWolf(wolves: Wolf[], name: string): Wolf | undefined {
  return wolves.find((w) => w.name === name);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
