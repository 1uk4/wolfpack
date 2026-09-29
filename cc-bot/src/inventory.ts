import { readFileSync } from "node:fs";
import { parse } from "yaml";

export type WolfRuntime = "claude" | "pi";

export type Wolf = {
  name: string;
  service: string;
  runtime: WolfRuntime;
};

type HostEntry = {
  wolf_name?: string;
  [key: string]: unknown;
};

type Group = {
  vars?: Record<string, unknown>;
  hosts?: Record<string, HostEntry | null> | null;
};

type InventoryYaml = {
  all: {
    vars?: Record<string, unknown>;
    children: Record<string, Group | undefined>;
  };
};

// Inventory groups that hold wolves, and the runtime each group runs.
const WOLF_GROUPS: { group: string; runtime: WolfRuntime }[] = [
  { group: "wolves", runtime: "claude" },
  { group: "pi_wolves", runtime: "pi" },
];

export function loadWolves(inventoryPath: string): Wolf[] {
  const raw = readFileSync(inventoryPath, "utf8");
  const doc = parse(raw) as InventoryYaml;
  const children = doc.all?.children ?? {};

  const wolves: Wolf[] = [];
  const seen = new Set<string>();

  for (const { group, runtime } of WOLF_GROUPS) {
    const hosts = children[group]?.hosts;
    if (!hosts) continue;
    for (const host of Object.values(hosts)) {
      const name = host?.wolf_name;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      wolves.push({ name, service: `${name}.service`, runtime });
    }
  }

  return wolves;
}

export function findWolf(wolves: Wolf[], name: string): Wolf | undefined {
  return wolves.find((w) => w.name === name);
}
