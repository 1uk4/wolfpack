import { describe, it, expect } from "vitest";
import {
  planMesh,
  allocatePorts,
  denFolderId,
  kbFolderId,
  opsInboxId,
  opsReceiptsId,
  isManagedFolderId,
  type PlanInput,
  type DeviceRegistry,
} from "./mesh.js";

const registry: DeviceRegistry = {
  devices: {
    hub: { role: "hub", host: "local", deviceId: "HUB", addr: "tcp://100.0.0.1:22000" },
    DEWEY: { role: "librarian", host: "sfo-01", deviceId: "DEW", tcpPort: 22000, guiPort: 8384, addr: "tcp://100.0.0.2:22000" },
    HAL: { role: "wolf", host: "sfo-01", deviceId: "HAL", tcpPort: 22001, guiPort: 8385, addr: "tcp://100.0.0.2:22001" },
    WORK: { role: "wolf", host: "sfo-01", deviceId: "WRK", tcpPort: 22002, guiPort: 8386, addr: "tcp://100.0.0.2:22002" },
  },
};

const input: PlanInput = {
  registry,
  domains: ["wolfpack", "personal"],
  wolvesRoot: "/Users/me/wolves",
  wolves: [
    { id: "DEWEY", name: "dewey", host: "sfo-01", role: "librarian", domains: [] },
    { id: "HAL", name: "hal", host: "sfo-01", role: "wolf", domains: ["wolfpack", "personal"] },
    { id: "WORK", name: "work", host: "sfo-01", role: "wolf", domains: ["wolfpack"] },
    { id: "LOCAL1", name: "luk4", host: "local", role: "wolf", domains: ["wolfpack"] },
  ],
};

const plan = planMesh(input);
const byKey = (k: string) => plan.find((p) => p.key === k)!;

describe("planMesh — star topology", () => {
  it("local wolves are not their own Syncthing devices", () => {
    expect(plan.find((p) => p.key === "LOCAL1")).toBeUndefined();
  });

  it("each wolf peers only with librarian + hub (star, not mesh)", () => {
    const hal = byKey("HAL");
    const peers = hal.peers.map((p) => p.key).sort();
    expect(peers).toEqual(["DEWEY", "hub"]);
    // HAL never peers with WORK
    expect(peers).not.toContain("WORK");
  });

  it("librarian owns kb-<domain> sendonly, listing all receivers", () => {
    const dewey = byKey("DEWEY");
    const kbWolfpack = dewey.folders.find((f) => f.id === kbFolderId("wolfpack"))!;
    expect(kbWolfpack.type).toBe("sendonly");
    // receivers of wolfpack: hub, HAL, WORK (+ owner)
    expect([...kbWolfpack.deviceIds].sort()).toEqual(["DEWEY", "HAL", "WORK", "hub"]);
  });

  it("private domain only reaches subscribers", () => {
    const dewey = byKey("DEWEY");
    const kbPersonal = dewey.folders.find((f) => f.id === kbFolderId("personal"))!;
    // personal: subscribed by HAL only (+ hub + owner); WORK excluded
    expect([...kbPersonal.deviceIds].sort()).toEqual(["DEWEY", "HAL", "hub"]);
    const work = byKey("WORK");
    expect(work.folders.find((f) => f.id === kbFolderId("personal"))).toBeUndefined();
  });

  it("subscriber folders are receiveonly and know only the owner", () => {
    const hal = byKey("HAL");
    const kbWolfpack = hal.folders.find((f) => f.id === kbFolderId("wolfpack"))!;
    expect(kbWolfpack.type).toBe("receiveonly");
    expect([...kbWolfpack.deviceIds].sort()).toEqual(["DEWEY", "HAL"]);
  });

  it("hub receives every domain (access + backup)", () => {
    const hub = byKey("hub");
    expect(hub.folders.find((f) => f.id === kbFolderId("wolfpack"))?.type).toBe("receiveonly");
    expect(hub.folders.find((f) => f.id === kbFolderId("personal"))?.type).toBe("receiveonly");
  });

  it("den backup: wolf sendonly → hub receiveonly", () => {
    const hal = byKey("HAL");
    const den = hal.folders.find((f) => f.id === denFolderId("sfo-01", "HAL"))!;
    expect(den.type).toBe("sendonly");
    expect(den.path).toBe("/home/wolf-HAL/den");

    const hub = byKey("hub");
    const hubDen = hub.folders.find((f) => f.id === denFolderId("sfo-01", "HAL"))!;
    expect(hubDen.type).toBe("receiveonly");
    expect(hubDen.path).toBe("/Users/me/wolves/sfo-01/hal/den");
  });

  it("librarian does not back up a den it doesn't own, and isn't a KB receiver", () => {
    const dewey = byKey("DEWEY");
    // dewey has its own den sendonly
    expect(dewey.folders.find((f) => f.id === denFolderId("sfo-01", "DEWEY"))?.type).toBe("sendonly");
    // dewey never receives kb (it's the source)
    expect(dewey.folders.every((f) => !f.id.startsWith("kb-") || f.type === "sendonly")).toBe(true);
  });
});

describe("librarian-ops lanes (star)", () => {
  it("remote wolf: inbox sendonly \u2192 Dewey, receipts receiveonly \u2190 Dewey", () => {
    const hal = byKey("HAL");
    const inbox = hal.folders.find((f) => f.id === opsInboxId("hal"))!;
    expect(inbox.type).toBe("sendonly");
    expect(inbox.path).toBe("/home/wolf-HAL/librarian/inbox/hal");
    expect([...inbox.deviceIds].sort()).toEqual(["DEWEY", "HAL"]);
    const receipts = hal.folders.find((f) => f.id === opsReceiptsId("hal"))!;
    expect(receipts.type).toBe("receiveonly");
  });

  it("Dewey receives every wolf's inbox and sends every wolf's receipts", () => {
    const dewey = byKey("DEWEY");
    const inbox = dewey.folders.find((f) => f.id === opsInboxId("hal"))!;
    expect(inbox.type).toBe("receiveonly");
    expect(inbox.path).toBe("/home/wolf-DEWEY/librarian/inbox/hal");
    const receipts = dewey.folders.find((f) => f.id === opsReceiptsId("hal"))!;
    expect(receipts.type).toBe("sendonly");
  });

  it("local wolf's ops lane rides the hub device, not its own", () => {
    const hub = byKey("hub");
    const inbox = hub.folders.find((f) => f.id === opsInboxId("luk4"))!;
    expect(inbox.type).toBe("sendonly");
    expect(inbox.path).toBe("/Users/me/wolves/librarian/inbox/luk4");
    expect([...inbox.deviceIds].sort()).toEqual(["DEWEY", "hub"]);
  });

  it("Dewey has no ops lane to itself", () => {
    const dewey = byKey("DEWEY");
    expect(dewey.folders.find((f) => f.id === opsInboxId("dewey"))).toBeUndefined();
  });
});

describe("local librarian (librarian == hub)", () => {
  // Librarian runs on the hub machine: no separate device, hub is the KB source.
  const localLibReg: DeviceRegistry = {
    devices: {
      hub: { role: "hub", host: "local", deviceId: "HUB", addr: "tcp://100.0.0.1:22000" },
      HAL: { role: "wolf", host: "sfo-01", deviceId: "HAL", tcpPort: 22001, guiPort: 8385, addr: "tcp://100.0.0.2:22001" },
    },
  };
  const localLibPlan = planMesh({
    registry: localLibReg,
    domains: ["wolfpack"],
    wolvesRoot: "/Users/me/wolves",
    wolves: [
      { id: "LUK4", name: "luk4", host: "local", role: "librarian", domains: [] },
      { id: "HAL", name: "hal", host: "sfo-01", role: "wolf", domains: ["wolfpack"] },
    ],
  });
  const k = (key: string) => localLibPlan.find((p) => p.key === key);

  it("hub is the KB source (sendonly), not a receiver", () => {
    const hub = k("hub")!;
    const kb = hub.folders.find((f) => f.id === kbFolderId("wolfpack"))!;
    expect(kb.type).toBe("sendonly");
    expect(kb.path).toBe("/Users/me/wolves/knowledge/base/domains/wolfpack");
    expect([...kb.deviceIds].sort()).toEqual(["HAL", "hub"]);
  });

  it("remote subscriber receives from the hub", () => {
    const hal = k("HAL")!;
    const kb = hal.folders.find((f) => f.id === kbFolderId("wolfpack"))!;
    expect(kb.type).toBe("receiveonly");
    expect([...kb.deviceIds].sort()).toEqual(["HAL", "hub"]);
  });

  it("ops lanes connect remote wolf to the hub (the local librarian)", () => {
    const hub = k("hub")!;
    const inbox = hub.folders.find((f) => f.id === opsInboxId("hal"))!;
    expect(inbox.type).toBe("receiveonly");
    expect(inbox.path).toBe("/Users/me/wolves/librarian/inbox/hal");
    expect([...inbox.deviceIds].sort()).toEqual(["HAL", "hub"]);
  });
});

describe("allocatePorts", () => {
  it("picks the lowest free pair on a host", () => {
    expect(allocatePorts(registry, "sfo-01")).toEqual({ tcpPort: 22003, guiPort: 8387 });
  });
  it("starts at base on an empty host", () => {
    expect(allocatePorts(registry, "fresh-host")).toEqual({ tcpPort: 22000, guiPort: 8384 });
  });
});

describe("isManagedFolderId", () => {
  it("matches kb- and den- ids only", () => {
    expect(isManagedFolderId("kb-wolfpack")).toBe(true);
    expect(isManagedFolderId("den-sfo-01-HAL")).toBe(true);
    expect(isManagedFolderId("ops-inbox-hal")).toBe(true);
    expect(isManagedFolderId("ops-receipts-hal")).toBe(true);
    expect(isManagedFolderId("my-personal-photos")).toBe(false);
  });
});
