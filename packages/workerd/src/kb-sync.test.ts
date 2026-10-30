import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KbSync, type KbSyncOptions } from "./kb-sync.js";
import { startLinkRig, type LinkRig } from "./testing/link-rig.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});
async function rig(o: Parameters<typeof startLinkRig>[0] = {}): Promise<LinkRig> {
  const r = await startLinkRig(o);
  cleanup.push(() => r.close());
  return r;
}
const tmpDir = () => {
  const d = mkdtempSync(join(tmpdir(), "kbsync-"));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};
const entry = (id: string, body = "Body") => `---\nid: ${id}\ntitle: "T"\ndomain: alpha\n---\n\n# T\n\n${body}\n`;
const E1 = "kb-alpha-aaaaaaa";
const E2 = "kb-alpha-bbbbbbb";

/** A KbSync used directly against the rig's hub with the rig's worker token. */
function direct(r: LinkRig, domains: string[], o: Partial<KbSyncOptions> = {}, mirrorDir = tmpDir()) {
  const urls: string[] = [];
  const sync = new KbSync({
    hubUrl: r.hub.url,
    token: r.token,
    mirrorDir,
    domains: () => domains,
    baseMs: 10,
    capMs: 40,
    pollMs: 0,
    fetchImpl: (async (u: string, init?: RequestInit) => (urls.push(`${init?.method ?? "GET"} ${new URL(u).pathname}${new URL(u).search}`), fetch(u, init))) as typeof fetch,
    ...o,
  });
  cleanup.push(() => sync.stop());
  return { sync, urls, mirrorDir };
}
const online = async (r: LinkRig) => {
  await r.waitPresence("online");
  await r.eventually(async () => (await r.registry("wolves")).every((w) => w.host === "box"), "wolves attached");
};
const settle = async (r: LinkRig, s: KbSync, d: string, rev?: number) => r.eventually(() => (s.status()[d]?.rev ?? 0) >= (rev ?? 1) && !s.status()[d]!.syncing, `${d} synced`);
const stateOf = (dir: string, d: string) => JSON.parse(readFileSync(join(dir, ".sync", `${d}.json`), "utf8")) as { epoch: string; rev: number; active: boolean };

describe("worker KB sync (hubd + workerd rig)", () => {
  it("fresh sync pulls whole files, versions/ included, into the mirror", async () => {
    const r = await rig({ kbDomains: ["alpha"], grants: { alpha: ["alpha"] } });
    await r.kbWrite("alpha", `entries/${E1}.md`, entry(E1));
    await r.kbWrite("alpha", `versions/${E1}/2026-01-01.md`, entry(E1, "old"));
    await r.kbWrite("alpha", "INDEX.md", "# Index\n");
    await online(r);
    const { sync, mirrorDir } = direct(r, ["alpha"]);
    sync.start();
    await settle(r, sync, "alpha", 3);
    expect(readFileSync(join(mirrorDir, "alpha", "entries", `${E1}.md`), "utf8")).toBe(entry(E1));
    expect(readFileSync(join(mirrorDir, "alpha", "versions", E1, "2026-01-01.md"), "utf8")).toBe(entry(E1, "old"));
    expect(readFileSync(join(mirrorDir, "alpha", "INDEX.md"), "utf8")).toBe("# Index\n");
    expect(stateOf(mirrorDir, "alpha").rev).toBe(3);
    expect(readdirSync(join(mirrorDir, "alpha", "entries")).every((n) => !n.startsWith("."))).toBe(true); // no temp files left
    expect(sync.revisions()).toEqual({ alpha: 3 });
  });

  it("resumes from the saved revision without a manifest diff", async () => {
    const r = await rig({ kbDomains: ["alpha"], grants: { alpha: ["alpha"] } });
    await r.kbWrite("alpha", `entries/${E1}.md`, entry(E1));
    await online(r);
    const a = direct(r, ["alpha"]);
    a.sync.start();
    await settle(r, a.sync, "alpha", 1);
    a.sync.stop();
    await r.kbWrite("alpha", `entries/${E2}.md`, entry(E2));
    const b = direct(r, ["alpha"], {}, a.mirrorDir);
    b.sync.start();
    await settle(r, b.sync, "alpha", 2);
    expect(b.urls.some((u) => u.startsWith("GET /v1/kb/domains/alpha/changes?since=1&epoch="))).toBe(true);
    expect(b.urls.some((u) => u.includes("manifest-diff"))).toBe(false);
    expect(readFileSync(join(a.mirrorDir, "alpha", "entries", `${E2}.md`), "utf8")).toBe(entry(E2));
  });

  it("an epoch change falls back to a manifest diff that also repairs local drift", async () => {
    const r = await rig({ kbDomains: ["alpha"], grants: { alpha: ["alpha"] } });
    await r.kbWrite("alpha", `entries/${E1}.md`, entry(E1));
    await online(r);
    const a = direct(r, ["alpha"]);
    a.sync.start();
    await settle(r, a.sync, "alpha", 1);
    a.sync.stop();
    const st = stateOf(a.mirrorDir, "alpha");
    writeFileSync(join(a.mirrorDir, ".sync", "alpha.json"), JSON.stringify({ v: 1, ...st, epoch: "old-epoch" }));
    writeFileSync(join(a.mirrorDir, "alpha", "entries", `${E2}.md`), "stale, not on the hub"); // gone on the hub
    writeFileSync(join(a.mirrorDir, "alpha", "entries", `${E1}.md`), "tampered");
    const b = direct(r, ["alpha"], {}, a.mirrorDir);
    b.sync.start();
    await r.eventually(() => stateOf(a.mirrorDir, "alpha").epoch === st.epoch, "epoch adopted");
    await b.sync.idle();
    expect(b.urls.some((u) => u.includes("manifest-diff"))).toBe(true);
    expect(existsSync(join(a.mirrorDir, "alpha", "entries", `${E2}.md`))).toBe(false);
    expect(readFileSync(join(a.mirrorDir, "alpha", "entries", `${E1}.md`), "utf8")).toBe(entry(E1));
  });

  it("below the floor (hub says reset) falls back to a manifest diff", async () => {
    const r = await rig({ kbDomains: ["alpha"], grants: { alpha: ["alpha"] } });
    await r.kbWrite("alpha", `entries/${E1}.md`, entry(E1));
    await online(r);
    const a = direct(r, ["alpha"]);
    a.sync.start();
    await settle(r, a.sync, "alpha", 1);
    a.sync.stop();
    await r.kbWrite("alpha", `entries/${E2}.md`, entry(E2));
    const st = stateOf(a.mirrorDir, "alpha");
    const b = direct(r, ["alpha"], {
      fetchImpl: (async (u: string, init?: RequestInit) => {
        if (u.includes("/changes?")) return new Response(JSON.stringify({ status: "reset", domain: "alpha", epoch: st.epoch, reason: "below_floor", floor: 99, revision: 2 }), { status: 200 });
        return fetch(u, init);
      }) as typeof fetch,
    }, a.mirrorDir);
    b.sync.start();
    await settle(r, b.sync, "alpha", 2);
    expect(readFileSync(join(a.mirrorDir, "alpha", "entries", `${E2}.md`), "utf8")).toBe(entry(E2));
  });

  it("a kb.changed push triggers the pull (no polling)", async () => {
    const r = await rig({ kbDomains: ["alpha"], grants: { alpha: ["alpha"] } });
    await r.waitPresence("online");
    const sync = r.workerd.kbSync!;
    await r.eventually(() => sync.status().alpha !== undefined, "alpha subscribed");
    await r.kbWrite("alpha", `entries/${E1}.md`, entry(E1));
    await r.eventually(() => r.mirrored("alpha", `entries/${E1}.md`) === entry(E1), "pushed change mirrored");
    await r.kbWrite("alpha", `entries/${E2}.md`, entry(E2));
    await r.eventually(() => r.mirrored("alpha", `entries/${E2}.md`) === entry(E2), "second change mirrored");
    await r.kbRemove("alpha", `entries/${E1}.md`);
    await r.eventually(() => r.mirrored("alpha", `entries/${E1}.md`) === undefined, "delete mirrored");
    expect(sync.status().alpha!.rev).toBe(3);
  });

  it("404 (not scanned yet) retries and never wipes the mirror; success follows", async () => {
    const r = await rig({ kbDomains: ["alpha"], grants: { alpha: ["alpha"] } });
    await r.kbWrite("alpha", `entries/${E1}.md`, entry(E1));
    const dir = tmpDir();
    mkdirSync(join(dir, "alpha", "entries"), { recursive: true });
    mkdirSync(join(dir, ".sync"), { recursive: true });
    writeFileSync(join(dir, "alpha", "entries", `${E2}.md`), "kept while the hub says 404");
    const m = await (await fetch(`${r.hub.url}/v1/kb/domains/alpha/manifest`, { headers: { Authorization: `Bearer ${r.token}` } })).json() as { epoch: string };
    writeFileSync(join(dir, ".sync", "alpha.json"), JSON.stringify({ v: 1, epoch: m.epoch, rev: 1, active: true }));
    let fails = 2;
    await online(r);
    const a = direct(r, ["alpha"], {
      fetchImpl: (async (u: string, init?: RequestInit) => (fails-- > 0 ? new Response("{}", { status: 404 }) : fetch(u, init))) as typeof fetch,
    }, dir);
    a.sync.start();
    await r.eventually(() => (a.sync.status().alpha?.failures ?? 0) >= 1, "first failure");
    expect(readFileSync(join(dir, "alpha", "entries", `${E2}.md`), "utf8")).toBe("kept while the hub says 404");
    await r.eventually(() => a.sync.status().alpha?.failures === 0 && !a.sync.status().alpha?.syncing, "recovered");
    expect(existsSync(join(dir, "alpha", "entries", `${E1}.md`))).toBe(true); // converged once the hub answered
  });

  it("5xx, 403 and network errors keep the mirror and keep retrying", async () => {
    const r = await rig({ kbDomains: ["alpha"], grants: { alpha: ["alpha"] } });
    await r.kbWrite("alpha", `entries/${E1}.md`, entry(E1));
    const dir = tmpDir();
    const seq = [500, 403, "net"] as const;
    let i = 0;
    await online(r);
    const a = direct(r, ["alpha"], {
      fetchImpl: (async (u: string, init?: RequestInit) => {
        const s = seq[i++];
        if (s === "net") throw new Error("boom");
        if (s) return new Response("no", { status: s });
        return fetch(u, init);
      }) as typeof fetch,
    }, dir);
    a.sync.start();
    await r.eventually(() => existsSync(join(dir, "alpha", "entries", `${E1}.md`)), "eventually synced");
    expect(i).toBeGreaterThanOrEqual(4);
  });

  it("a domain outside the registry-granted union is never received (403 and no push)", async () => {
    const r = await rig({ kbDomains: ["alpha", "beta"], grants: { alpha: ["alpha"] }, wolfDomains: { alpha: ["alpha", "beta"] } });
    await r.waitPresence("online");
    const other = r.mintWorker("other");
    const raw = await r.rawLink(other.token);
    raw.hello({ hostId: "other", wolves: [] });
    await raw.until(() => raw.frames.some((f) => f.t === "welcome"), "welcome");
    await r.kbWrite("alpha", `entries/${E1}.md`, entry(E1));
    await r.kbWrite("beta", "entries/kb-beta-ccccccc.md", entry("kb-beta-ccccccc"));
    await r.eventually(() => r.mirrored("alpha", `entries/${E1}.md`) !== undefined, "alpha mirrored");
    // the worker reports beta but the registry granted only alpha: beta is not even requested
    expect(Object.keys(r.workerd.kbSync!.status())).toEqual(["alpha"]);
    expect(existsSync(join(r.kbMirrorDir, "beta"))).toBe(false);
    const get = (tok: string) => fetch(`${r.hub.url}/v1/kb/domains/beta/manifest`, { headers: { Authorization: `Bearer ${tok}` } });
    expect((await get(r.token)).status).toBe(403);
    expect((await get(other.token)).status).toBe(403);
    expect(r.hub.link.pushKbChanged("beta", 1, "e")).toEqual([]);
    expect(r.hub.link.pushKbChanged("alpha", 1, "e")).toEqual(["box"]);
    expect(raw.frames.some((f) => f.t === "kb.changed")).toBe(false);
  });

  it("a domain removed from the union stops syncing; its mirror is kept and marked inactive", async () => {
    const r = await rig({ kbDomains: ["alpha"], grants: { alpha: ["alpha"] } });
    await r.waitPresence("online");
    await r.kbWrite("alpha", `entries/${E1}.md`, entry(E1));
    await r.eventually(() => r.mirrored("alpha", `entries/${E1}.md`) !== undefined, "mirrored");
    await r.workerd.supervisor.removeWolf("alpha");
    await r.eventually(() => stateOf(r.kbMirrorDir, "alpha").active === false, "inactive");
    await r.kbWrite("alpha", `entries/${E2}.md`, entry(E2));
    await new Promise((res) => setTimeout(res, 300));
    expect(r.mirrored("alpha", `entries/${E1}.md`)).toBe(entry(E1));
    expect(r.mirrored("alpha", `entries/${E2}.md`)).toBeUndefined();
    expect(r.workerd.kbSync!.status().alpha!.active).toBe(false);
    expect(r.workerd.kbSync!.revisions()).toEqual({});
  });

  it("rejects a file whose content does not match the hub's hash and applies nothing", async () => {
    const r = await rig({ kbDomains: ["alpha"], grants: { alpha: ["alpha"] } });
    await r.kbWrite("alpha", `entries/${E1}.md`, entry(E1));
    await online(r);
    const a = direct(r, ["alpha"], {
      fetchImpl: (async (u: string, init?: RequestInit) => {
        const res = await fetch(u, init);
        if (!u.includes("manifest-diff")) return res;
        const j = (await res.json()) as { files: { content: string }[] };
        for (const f of j.files) f.content += "tampered";
        return new Response(JSON.stringify(j), { status: 200 });
      }) as typeof fetch,
    });
    a.sync.start();
    await r.eventually(() => (a.sync.status().alpha?.failures ?? 0) >= 2, "repeated rejection");
    expect(a.sync.status().alpha!.lastError).toMatch(/hash mismatch/);
    expect(existsSync(join(a.mirrorDir, "alpha", "entries", `${E1}.md`))).toBe(false);
    expect(existsSync(join(a.mirrorDir, ".sync", "alpha.json"))).toBe(false);
  });
});

