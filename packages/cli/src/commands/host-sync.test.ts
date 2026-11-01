import { describe, it, expect, vi, beforeEach } from "vitest";

const putFolder = vi.fn(async (_f: { id: string }) => {});
const scripts: string[] = [];
vi.mock("../syncthing.js", () => ({
  readLocalSyncthing: () => ({ url: "http://x", apiKey: "k" }),
  localTailscaleIp: () => "100.64.0.1",
  SyncthingRest: class {
    myId = async () => "MACID";
    putDevice = async () => {};
    putFolder = putFolder;
  },
  buildDevice: (...a: unknown[]) => a,
  buildFolder: (id: string, p: string, type: string) => ({ id, p, type }),
}));
vi.mock("../ssh-helper.js", () => ({
  scpToHost: (_h: unknown, file: string) => {
    scripts.push(require("node:fs").readFileSync(file, "utf8"));
  },
  execSsh: () => ({ code: 0, stdout: "AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH\n", stderr: "" }),
}));
vi.mock("../config.js", () => ({ loadConfig: () => ({ wolvesRoot: require("node:os").tmpdir() + "/wp-hostsync-test" }), getHost: () => undefined }));

import { ensureDenMirror } from "./host-sync.js";

describe("ensureDenMirror", () => {
  beforeEach(() => { putFolder.mockClear(); scripts.length = 0; });

  it("uses the live den-<host>-<wolf> id on both ends, never <host>-<wolf>-den", async () => {
    await ensureDenMirror("sfo-01", { address: "1.2.3.4", port: 1, apiKey: "x" } as never, { id: "W1hOrJ", name: "hal" });
    const ids = putFolder.mock.calls.map((c) => c[0].id);
    expect(ids).toEqual(["den-sfo-01-W1hOrJ"]);
    expect(scripts[0]).toContain("den-sfo-01-W1hOrJ");
    expect(scripts[0]).not.toContain("W1hOrJ-den");
  });
});
