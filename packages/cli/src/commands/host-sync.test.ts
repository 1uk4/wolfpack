import { describe, it, expect, vi, beforeEach } from "vitest";

type Folder = { id: string; path: string; type: string; devices: Array<{ deviceID: string }> };
const hub: { folders: Folder[] } = { folders: [] };
const writes: string[] = [];
const ssh: string[] = [];

vi.mock("../syncthing.js", () => ({
  readLocalSyncthing: () => ({ url: "http://x", apiKey: "k" }),
  SyncthingRest: class {
    listFolders = async () => hub.folders.map((f) => ({ ...f, devices: [...f.devices] }));
    putFolder = async () => { writes.push("putFolder"); };
    putDevice = async () => { writes.push("putDevice"); };
    deleteFolder = async () => { writes.push("deleteFolder"); };
  },
}));
vi.mock("../ssh-helper.js", () => ({
  scpToHost: () => { ssh.push("scp"); },
  execSsh: () => { ssh.push("exec"); return { code: 0, stdout: "", stderr: "" }; },
}));
vi.mock("../config.js", () => ({ loadConfig: () => ({ wolvesRoot: "/w", hosts: {} }), getHost: () => undefined }));

vi.mock("../mesh.js", async (orig) => ({
  ...(await orig<typeof import("../mesh.js")>()),
  loadDevices: () => ({ devices: { W1hOrJ: { role: "wolf", host: "sfo-01", deviceId: "WOLFINSTANCE" } } }),
}));

import { ensureDenMirror } from "./host-sync.js";

const live = (): Folder => ({
  id: "den-sfo-01-W1hOrJ",
  path: "/Users/me/wolves/sfo-01/hal/den",
  type: "receiveonly",
  devices: [{ deviceID: "MACID" }, { deviceID: "WOLFINSTANCE" }],
});

describe("ensureDenMirror (read-only)", () => {
  beforeEach(() => { hub.folders = []; writes.length = 0; ssh.length = 0; });

  it("leaves an existing den folder untouched: path, type and devices unchanged, no writes, no VPS root syncthing", async () => {
    hub.folders = [live()];
    const before = JSON.stringify(hub.folders);
    const r = await ensureDenMirror("sfo-01", { id: "W1hOrJ", name: "hal" });
    expect(r.folderId).toBe("den-sfo-01-W1hOrJ");
    expect(r.macDen).toBe("/Users/me/wolves/sfo-01/hal/den");
    expect(r.warnings).toEqual([]);
    expect(writes).toEqual([]);
    expect(ssh).toEqual([]);
    expect(JSON.stringify(hub.folders)).toBe(before);
    const f = hub.folders[0]!;
    expect(f.path).toBe("/Users/me/wolves/sfo-01/hal/den");
    expect(f.type).toBe("receiveonly");
    expect(f.devices.map((d) => d.deviceID)).toEqual(["MACID", "WOLFINSTANCE"]);
  });

  it("refuses (pointing at `wolfpack mesh`) when the folder is missing, and creates nothing, incl. no <host>-<wolf>-den", async () => {
    await expect(ensureDenMirror("sfo-01", { id: "W1hOrJ", name: "hal" })).rejects.toThrow(/wolfpack mesh/);
    expect(writes).toEqual([]);
    expect(ssh).toEqual([]);
    expect(hub.folders).toEqual([]);
  });

  it("warns (does not fail or write) on a non-receiveonly folder missing the wolf's device", async () => {
    hub.folders = [{ ...live(), type: "sendonly", devices: [{ deviceID: "MACID" }, { deviceID: "ROOTVPS" }] }];
    const before = JSON.stringify(hub.folders);
    const r = await ensureDenMirror("sfo-01", { id: "W1hOrJ", name: "hal" });
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toMatch(/sendonly.*receiveonly/);
    expect(r.warnings[1]).toContain("WOLFINSTANCE");
    expect(writes).toEqual([]);
    expect(JSON.stringify(hub.folders)).toBe(before);
  });
});
