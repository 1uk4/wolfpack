/** Link-only mode: hub link + KB sync + announce, and NOTHING supervised or spawned. */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runWorkerd } from "./run.js";
import { startLinkRig, type LinkRig } from "./testing/link-rig.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

describe("runWorkerd link-only", () => {
  it("opens the link as host, announces the wolf, syncs the KB (base layout), and spawns no wolfd", async () => {
    const r: LinkRig = await startLinkRig({ wolves: ["hal"], noHub: true, kbDomains: ["personal"], grants: { hal: ["personal"] } });
    cleanup.push(() => r.close());
    const tmp = mkdtempSync(join(tmpdir(), "link-only-"));
    cleanup.push(() => rmSync(tmp, { recursive: true, force: true }));
    const marker = join(tmp, "spawned");
    // If anything were spawned, this "wolfd" would leave a marker; wolvesDir holds a real hal wolf.yaml that must be ignored.
    const script = join(tmp, "spawn.mjs");
    writeFileSync(script, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "x");`);
    const lines: string[] = [];
    const mirror = join(tmp, "mirror");
    const w = await runWorkerd({
      wolvesDir: r.wolvesDir,
      command: [process.execPath, script],
      port: 0,
      linkOnly: true,
      announce: ["hal"],
      hub: { hubUrl: r.hub.url, token: r.token, hostId: r.hostId },
      linkOptions: { baseMs: 20, capMs: 200, rand: () => 0.5 },
      kbMirrorDir: mirror,
      kbMirrorLayout: "base",
      kbSync: { baseMs: 20, capMs: 200, pollMs: 0 },
      wake: { intervalMs: 3_600_000, netPollMs: 3_600_000 },
      kbOps: join(tmp, "ops"),
      outboxDir: join(tmp, "outbox"),
      feed: false,
      log: (l) => void lines.push(l),
    });
    cleanup.push(() => w.close());
    await r.waitPresence("online");
    expect(w.supervisor.wolves()).toEqual([]);
    expect(w.supervisor.configs()).toEqual([]);
    expect((await r.registry("wolves")).map((x) => [x.name, x.host])).toEqual([["hal", "box"]]);
    await r.kbWrite("personal", "INDEX.md", "# Index\n");
    await r.eventually(() => existsSync(join(mirror, "domains", "personal", "INDEX.md")), "mirror filled (base layout)");
    await new Promise((res) => setTimeout(res, 300));
    expect(existsSync(marker)).toBe(false);
    expect(lines.some((l) => l.includes("link-only"))).toBe(true);
  });

  it("refuses link-only with nothing to announce or without a hub", async () => {
    await expect(runWorkerd({ linkOnly: true, announce: [], hub: false, port: 0 })).rejects.toThrow(/announced wolf/);
    await expect(runWorkerd({ linkOnly: true, announce: ["hal"], hub: false, port: 0 })).rejects.toThrow(/hub link/);
  });
});
