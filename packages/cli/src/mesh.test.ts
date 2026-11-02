import { describe, it, expect, vi } from "vitest";
import { diff, folderFieldDrift, buildRemoteApplyScript, resolveFolderDeviceIds } from "./mesh-reconcile.js";
import {
  planMesh,
  allocatePorts,
  denFolderId,
  isManagedFolderId,
  type PlanInput,
  type DeviceRegistry,
} from "./mesh.js";

const registry: DeviceRegistry = {
  devices: {
    hub: { role: "hub", host: "local", deviceId: "HUB", addr: "tcp://100.64.0.1:22000" },
    DEWEY: { role: "librarian", host: "host-a", deviceId: "DEW", tcpPort: 22000, guiPort: 8384, addr: "tcp://100.64.0.2:22000" },
    HAL: { role: "wolf", host: "host-a", deviceId: "HAL", tcpPort: 22001, guiPort: 8385, addr: "tcp://100.64.0.2:22001" },
    WORK: { role: "wolf", host: "host-a", deviceId: "WRK", tcpPort: 22002, guiPort: 8386, addr: "tcp://100.64.0.2:22002" },
  },
};

const input: PlanInput = {
  registry,
  wolvesRoot: "/Users/me/wolves",
  wolves: [
    { id: "DEWEY", name: "dewey", host: "host-a", role: "librarian" },
    { id: "HAL", name: "hal", host: "host-a", role: "wolf" },
    { id: "WORK", name: "work", host: "host-a", role: "wolf" },
    { id: "LOCAL1", name: "luk4", host: "local", role: "wolf" },
  ],
};

const plan = planMesh(input);
const byKey = (k: string) => plan.find((p) => p.key === k)!;

describe("planMesh - den backups only", () => {
  it("local wolves are not their own Syncthing devices", () => {
    expect(plan.find((p) => p.key === "LOCAL1")).toBeUndefined();
  });

  it("each wolf peers only with the hub", () => {
    expect(byKey("HAL").peers.map((p) => p.key)).toEqual(["hub"]);
  });

  it("den backup: wolf sendonly -> hub receiveonly", () => {
    const den = byKey("HAL").folders.find((f) => f.id === denFolderId("host-a", "HAL"))!;
    expect(den.type).toBe("sendonly");
    expect(den.path).toBe("/home/wolf-HAL/den");
    const hubDen = byKey("hub").folders.find((f) => f.id === "den-host-a-HAL")!;
    expect(hubDen.type).toBe("receiveonly");
    expect(hubDen.path).toBe("/Users/me/wolves/host-a/hal/den");
  });

  it("never plans kb-* or ops-* folders, on any instance", () => {
    const ids = plan.flatMap((p) => p.folders.map((f) => f.id));
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => id.startsWith("den-"))).toBe(true);
    expect(ids.some((id) => id.startsWith("kb-") || id.startsWith("ops-"))).toBe(false);
  });

  it("keeps one den id per provisioned remote wolf", () => {
    expect(byKey("hub").folders.map((f) => f.id).sort()).toEqual([
      "den-host-a-DEWEY",
      "den-host-a-HAL",
      "den-host-a-WORK",
    ]);
  });
});

describe("allocatePorts", () => {
  it("picks the lowest free pair on a host", () => {
    expect(allocatePorts(registry, "host-a")).toEqual({ tcpPort: 22003, guiPort: 8387 });
  });
  it("starts at base on an empty host", () => {
    expect(allocatePorts(registry, "fresh-host")).toEqual({ tcpPort: 22000, guiPort: 8384 });
  });
});

describe("isManagedFolderId (prune guard)", () => {
  it("matches den- ids only; kb-/ops- are never pruned", () => {
    expect(isManagedFolderId("den-host-a-HAL")).toBe(true);
    expect(isManagedFolderId("kb-wolfpack")).toBe(false);
    expect(isManagedFolderId("ops-inbox-hal")).toBe(false);
    expect(isManagedFolderId("ops-receipts-hal")).toBe(false);
    expect(isManagedFolderId("my-personal-photos")).toBe(false);
  });
});

describe("drift diff (checkMesh) never touches kb-/ops- folders", () => {
  it("does not report kb-*/ops-* as stale, but reports a stale den- id; missing den still reported", () => {
    const live = new Set(["kb-wolfpack", "kb-personal", "ops-inbox-hal", "ops-receipts-hal", "den-host-a-OLD", "den-host-a-HAL", "photos"]);
    const d = diff("HAL", new Set(["den-host-a-HAL", "den-host-a-NEW"]), live);
    expect(d.stale).toEqual(["den-host-a-OLD"]);
    expect(d.missing).toEqual(["den-host-a-NEW"]);
  });
});

describe("field-level drift report (mesh --check)", () => {
  const desired = [{ id: "den-sfo-01-W1hOrJ", path: "/w/sfo-01/hal/den", type: "receiveonly", deviceIds: ["HUB", "WOLF"] }];
  const live = (over: object = {}) => [{
    id: "den-sfo-01-W1hOrJ", path: "/w/sfo-01/hal/den", type: "receiveonly",
    devices: [{ deviceID: "HUB" }, { deviceID: "WOLF" }], ...over,
  }];
  it("a matching folder is no drift", () => {
    expect(folderFieldDrift(desired, live())).toEqual([]);
  });
  it("reports a different device list, type and path", () => {
    expect(folderFieldDrift(desired, live({ devices: [{ deviceID: "HUB" }, { deviceID: "ROOTVPS" }] })))
      .toEqual(["den-sfo-01-W1hOrJ: devices +[WOLF] -[ROOTVPS]"]);
    expect(folderFieldDrift(desired, live({ type: "sendonly", path: "/elsewhere" }))).toEqual([
      "den-sfo-01-W1hOrJ: type sendonly -> receiveonly",
      "den-sfo-01-W1hOrJ: path /elsewhere -> /w/sfo-01/hal/den",
    ]);
  });
  it("ignores folders that are not live (that is 'missing', not 'changed')", () => {
    expect(folderFieldDrift(desired, [])).toEqual([]);
  });
});

describe("applyRemote script", () => {
  it("creates the .stfolder marker and chown -R for den folders", () => {
    const script = buildRemoteApplyScript("HAL", byKey("HAL"), registry);
    expect(script).toContain('mkdir -p "/home/wolf-HAL/den/.stfolder"');
    expect(script).toContain('chown -R wolf-HAL:wolf-HAL "/home/wolf-HAL/den"');
    expect(script).toContain("den-host-a-HAL");
    expect(script).not.toMatch(/kb-|ops-/);
  });
});

describe("resolveFolderDeviceIds", () => {
  it("warns when a device key is missing from devices.yaml, and drops it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = { id: "den-x", path: "/p", type: "sendonly" as const, deviceIds: ["HAL", "GHOST"] };
    expect(resolveFolderDeviceIds(f, "HAL", registry)).toEqual(["HAL"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("GHOST");
    warn.mockRestore();
  });
});
