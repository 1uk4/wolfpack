import { readFileSync } from "node:fs";
import { parse } from "yaml";

export type Wolf = {
  name: string;
  service: string;
};

type InventoryYaml = {
  all: {
    vars?: Record<string, unknown>;
    children: {
      wolves: {
        hosts: Record<
          string,
          {
            wolf_name: string;
            [key: string]: unknown;
          }
        >;
      };
      [group: string]: unknown;
    };
  };
};

export function loadWolves(inventoryPath: string): Wolf[] {
  const raw = readFileSync(inventoryPath, "utf8");
  const doc = parse(raw) as InventoryYaml;
  const hosts = doc.all.children.wolves.hosts;
  return Object.values(hosts).map((host) => ({
    name: host.wolf_name,
    service: `${host.wolf_name}.service`,
  }));
}

export function findWolf(wolves: Wolf[], name: string): Wolf | undefined {
  return wolves.find((w) => w.name === name);
}
