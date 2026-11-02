import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    baseMs: 10,
    capMs: 40,
    pollMs: 0,
    fetchImpl: (async (u: string, init?: RequestInit) => (urls.push(`${init?.method ?? "GET"} ${new URL(u).pathname}${new URL(u).search}`), fetch(u, init))) as typeof fetch,
    ...o,
  });
  const start = sync.start.bind(sync);
  sync.start = () => (start(), sync.setGranted(domains)); // the registry grant, as a welcome would deliver it
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

  it("layout base syncs into <mirror>/domains/<d>/ with .sync/ unchanged; the default stays flat", async () => {
    const r = await rig({ kbDomains: ["alpha"], grants: { alpha: ["alpha"] } });
    await r.kbWrite("alpha", `entries/${E1}.md`, entry(E1));
    await r.kbWrite("alpha", `versions/${E1}/2026-01-01.md`, entry(E1, "old"));
    await online(r);
    const base = direct(r, ["alpha"], { layout: "base" });
    base.sync.start();
    await settle(r, base.sync, "alpha", 2);
    expect(readFileSync(join(base.mirrorDir, "domains", "alpha", "entries", `${E1}.md`), "utf8")).toBe(entry(E1));
    expect(readFileSync(join(base.mirrorDir, "domains", "alpha", "versions", E1, "2026-01-01.md"), "utf8")).toBe(entry(E1, "old"));
    expect(existsSync(join(base.mirrorDir, "alpha"))).toBe(false);
    expect(stateOf(base.mirrorDir, "alpha").rev).toBe(2);
    expect(base.sync.mirrorPath("alpha")).toBe(join(base.mirrorDir, "domains", "alpha"));

    const flat = direct(r, ["alpha"]);
    flat.sync.start();
    await settle(r, flat.sync, "alpha", 2);
    expect(existsSync(join(flat.mirrorDir, "alpha", "entries", `${E1}.md`))).toBe(true);
    expect(existsSync(join(flat.mirrorDir, "domains"))).toBe(false);
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
    const b = direct(r, ["alpha"], { verifyOnStart: false }, a.mirrorDir);
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
    const calls: string[] = [];
    (r.workerd.kbSync as unknown as { f: typeof fetch }).f = (async () => (calls.push("fetch"), new Response("{}", { status: 500 }))) as typeof fetch;
    r.workerd.kbSync!.notify("alpha", 9, "e"); // a stray hint for an unsubscribed domain: never fetched
    await r.workerd.kbSync!.idle();
    expect(calls).toEqual([]);
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

  const guardSetup = async () => {
    const r = await rig({ kbDomains: ["alpha"], grants: { alpha: ["alpha"] } });
    for (const id of [E1, E2, "kb-alpha-ccccccc"]) await r.kbWrite("alpha", `entries/${id}.md`, entry(id));
    await online(r);
    const a = direct(r, ["alpha"]);
    a.sync.start();
    await settle(r, a.sync, "alpha", 3);
    a.sync.stop();
    const st = stateOf(a.mirrorDir, "alpha");
    // the hub now claims the domain is empty
    const emptyFetch = (async (u: string, init?: RequestInit) => {
      if (!u.includes("manifest-diff")) return fetch(u, init);
      const have = Object.keys((JSON.parse(String(init!.body)) as { files: object }).files);
      return new Response(JSON.stringify({ domain: "alpha", epoch: st.epoch, revision: 0, files: [], deletes: have.map((path) => ({ path })), pending: [] }), { status: 200 });
    }) as typeof fetch;
    return { r, a, st, emptyFetch };
  };

  it("mass-delete guard: no saved state + an empty 200 manifest-diff deletes nothing; status shows the refusals", async () => {
    const { r, a, emptyFetch } = await guardSetup();
    rmSync(join(a.mirrorDir, ".sync", "alpha.json"));
    const b = direct(r, ["alpha"], { fetchImpl: emptyFetch }, a.mirrorDir);
    b.sync.start();
    await r.eventually(() => (b.sync.status().alpha?.refusals ?? 0) >= 2, "guard keeps refusing");
    expect(b.sync.status().alpha!.lastError).toMatch(/mass-delete guard/);
    expect(b.sync.status().alpha!.lastRefusalAt).toBeGreaterThan(0);
    expect(readdirSync(join(a.mirrorDir, "alpha", "entries")).length).toBe(3);
  });

  it("no saved state + allowMassDelete (or the flag file) lets the delete through, once", async () => {
    const { r, a, st, emptyFetch } = await guardSetup();
    rmSync(join(a.mirrorDir, ".sync", "alpha.json"));
    const b = direct(r, ["alpha"], { fetchImpl: emptyFetch }, a.mirrorDir);
    b.sync.start();
    await r.eventually(() => (b.sync.status().alpha?.refusals ?? 0) >= 1, "refused first");
    b.sync.allowMassDelete("alpha");
    await r.eventually(() => readdirSync(join(a.mirrorDir, "alpha", "entries")).length === 0, "deleted");
    await b.sync.idle();
    expect(stateOf(a.mirrorDir, "alpha").epoch).toBe(st.epoch);
    // flag file variant
    writeFileSync(join(a.mirrorDir, "alpha", "entries", `${E1}.md`), entry(E1));
    writeFileSync(join(a.mirrorDir, "alpha", "entries", `${E2}.md`), entry(E2));
    rmSync(join(a.mirrorDir, ".sync", "alpha.json"));
    writeFileSync(join(a.mirrorDir, ".sync", "alpha.allow-mass-delete"), "");
    const c = direct(r, ["alpha"], { fetchImpl: emptyFetch }, a.mirrorDir);
    c.sync.start();
    await r.eventually(() => readdirSync(join(a.mirrorDir, "alpha", "entries")).length === 0 && !existsSync(join(a.mirrorDir, ".sync", "alpha.allow-mass-delete")), "flag consumed, deleted");
  });

  it("a refused verify diff with saved state is non-fatal: incremental updates continue", async () => {
    const { r, a, emptyFetch } = await guardSetup();
    await r.kbWrite("alpha", "entries/kb-alpha-ddddddd.md", entry("kb-alpha-ddddddd"));
    const b = direct(r, ["alpha"], { fetchImpl: emptyFetch }, a.mirrorDir); // verifyOnStart default true
    b.sync.start();
    await settle(r, b.sync, "alpha", 4);
    expect(b.sync.status().alpha!.refusals).toBe(1);
    expect(readdirSync(join(a.mirrorDir, "alpha", "entries")).length).toBe(4);
    await r.kbWrite("alpha", "entries/kb-alpha-eeeeeee.md", entry("kb-alpha-eeeeeee"));
    b.sync.notify("alpha", 5, "e");
    await settle(r, b.sync, "alpha", 5);
    expect(readdirSync(join(a.mirrorDir, "alpha", "entries")).length).toBe(5);
  });

  it("the override is scoped to one run: an unused allowMassDelete does not fire on a later guarded diff after a hub reset", async () => {
    const { r, a, st, emptyFetch } = await guardSetup();
    const logs: string[] = [];
    const b = direct(r, ["alpha"], { verifyOnStart: false, fetchImpl: emptyFetch, log: (m) => logs.push(m) }, a.mirrorDir);
    b.sync.start();
    await settle(r, b.sync, "alpha", 3);
    b.sync.allowMassDelete("alpha"); // the next run is incremental and never needs it
    await b.sync.idle();
    expect((b.sync as unknown as { overrides: Set<string> }).overrides.has("alpha")).toBe(false);
    // an epoch rotation: the hub answers reset, the diff is required and the (cleared) override must not apply
    writeFileSync(join(a.mirrorDir, ".sync", "alpha.json"), JSON.stringify({ v: 1, ...st, epoch: "rotated" }));
    b.sync.syncAll();
    await r.eventually(() => (b.sync.status().alpha?.refusals ?? 0) >= 1, "refused after reset");
    expect(readdirSync(join(a.mirrorDir, "alpha", "entries")).length).toBe(3);
    expect(logs.some((l) => l.includes("continuing incrementally"))).toBe(false); // reset seen: refusal is not mislabelled as non-fatal verify
  });

  it("the override covers every round of a multi-round diff", async () => {
    const { r, a, st } = await guardSetup();
    rmSync(join(a.mirrorDir, ".sync", "alpha.json"));
    const hash = (t: string) => "sha256:" + createHash("sha256").update(t, "utf-8").digest("hex");
    const N = "kb-alpha-nnnnnnn";
    const content = entry(N);
    let round = 0;
    const fake = (async (u: string, init?: RequestInit) => {
      if (!u.includes("manifest-diff")) return fetch(u, init);
      round++;
      const have = Object.keys((JSON.parse(String(init!.body)) as { files: object }).files);
      const body = round === 1
        ? { domain: "alpha", epoch: st.epoch, revision: 7, files: [{ path: `entries/${N}.md`, contentHash: hash(content), encoding: "utf8", content }], deletes: have.slice(0, 2).map((path) => ({ path })), pending: ["entries/kb-alpha-zzzzzzz.md"] }
        : { domain: "alpha", epoch: st.epoch, revision: 7, files: [], deletes: have.map((path) => ({ path })), pending: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const b = direct(r, ["alpha"], { fetchImpl: fake }, a.mirrorDir);
    b.sync.allowMassDelete("alpha"); // armed before start: taken by the first run
    b.sync.start();
    await settle(r, b.sync, "alpha", 7);
    expect(round).toBe(2);
    expect(b.sync.status().alpha!.refusals).toBe(0);
    expect((b.sync as unknown as { overrides: Set<string> }).overrides.size).toBe(0);
  });

  it("a failed diff keeps the flag file; it is deleted only after the diff is applied and saved", async () => {
    const { r, a, emptyFetch } = await guardSetup();
    rmSync(join(a.mirrorDir, ".sync", "alpha.json"));
    const flag = join(a.mirrorDir, ".sync", "alpha.allow-mass-delete");
    writeFileSync(flag, "");
    let fail = true;
    const flaky = (async (u: string, init?: RequestInit) => {
      if (fail && u.includes("manifest-diff")) {
        const bad = { path: "entries/kb-alpha-bad0000.md", contentHash: "sha256:" + "0".repeat(64), encoding: "utf8", content: "x" };
        return new Response(JSON.stringify({ domain: "alpha", epoch: "e", revision: 1, files: [bad], deletes: [], pending: [] }), { status: 200 });
      }
      return emptyFetch(u, init);
    }) as typeof fetch;
    const b = direct(r, ["alpha"], { fetchImpl: flaky }, a.mirrorDir);
    b.sync.start();
    await r.eventually(() => (b.sync.status().alpha?.failures ?? 0) >= 2, "diff keeps failing");
    expect(existsSync(flag)).toBe(true);
    expect(readdirSync(join(a.mirrorDir, "alpha", "entries")).length).toBe(3);
    fail = false;
    await r.eventually(() => !existsSync(flag) && readdirSync(join(a.mirrorDir, "alpha", "entries")).length === 0, "applied, then flag consumed");
  });

  it("the anySignal fallback removes its listeners from the long-lived signal", async () => {
    const r = await rig({ kbDomains: ["alpha"], grants: { alpha: ["alpha"] } });
    await r.kbWrite("alpha", `entries/${E1}.md`, entry(E1));
    await online(r);
    const orig = (AbortSignal as unknown as { any?: unknown }).any;
    (AbortSignal as unknown as { any?: unknown }).any = undefined; // force the manual fallback
    try {
      const a = direct(r, ["alpha"]);
      const ac = (a.sync as unknown as { ac: AbortController }).ac;
      let added = 0;
      let removed = 0;
      const add = ac.signal.addEventListener.bind(ac.signal);
      const rem = ac.signal.removeEventListener.bind(ac.signal);
      ac.signal.addEventListener = ((t: string, f: never, o: never) => (t === "abort" && added++, add(t, f, o))) as typeof add;
      ac.signal.removeEventListener = ((t: string, f: never, o: never) => (t === "abort" && removed++, rem(t, f, o))) as typeof rem;
      a.sync.start();
      await settle(r, a.sync, "alpha", 1);
      expect(added).toBeGreaterThan(0);
      expect(removed).toBe(added);
    } finally {
      (AbortSignal as unknown as { any?: unknown }).any = orig;
    }
  });

  it("a welcome without grantedDomains keeps the current set", async () => {
    const r = await rig({ kbDomains: ["alpha"], grants: { alpha: ["alpha"] } });
    await r.kbWrite("alpha", `entries/${E1}.md`, entry(E1));
    await online(r);
    const a = direct(r, ["alpha"]);
    a.sync.start();
    await settle(r, a.sync, "alpha", 1);
    a.sync.applyWelcome(undefined);
    await a.sync.idle();
    expect(a.sync.status().alpha!.active).toBe(true);
    expect(stateOf(a.mirrorDir, "alpha").active).toBe(true);
    a.sync.applyWelcome([]);
    expect(a.sync.status().alpha!.active).toBe(false);
  });

  it("registry-only: a domain granted in the registry but absent from wolf.yaml syncs", async () => {
    const r = await rig({ kbDomains: ["alpha"], grants: { alpha: ["alpha"] }, wolfDomains: { alpha: [] } });
    await r.waitPresence("online");
    await r.kbWrite("alpha", `entries/${E1}.md`, entry(E1));
    await r.eventually(() => r.mirrored("alpha", `entries/${E1}.md`) === entry(E1), "mirrored");
  });

  it("a grant added mid-connection starts syncing without a reconnect", async () => {
    const r = await rig({ kbDomains: ["alpha", "beta"], grants: { alpha: ["alpha"] } });
    await r.waitPresence("online");
    await r.kbWrite("beta", "entries/kb-beta-ccccccc.md", entry("kb-beta-ccccccc"));
    await new Promise((res) => setTimeout(res, 100));
    expect(r.workerd.kbSync!.status().beta).toBeUndefined();
    const attempts = r.workerd.link!.status().attempts;
    await r.grant("alpha", ["alpha", "beta"]);
    await r.eventually(() => r.mirrored("beta", "entries/kb-beta-ccccccc.md") !== undefined, "beta mirrored");
    expect(r.workerd.link!.status()).toMatchObject({ state: "online", attempts });
    await r.grant("alpha", ["alpha"]);
    await r.eventually(() => r.workerd.kbSync!.status().beta?.active === false, "beta deactivated");
  });

  it("an ungranted wolf.yaml domain is never requested", async () => {
    const urls: string[] = [];
    const r = await rig({
      kbDomains: ["alpha", "beta"],
      grants: { alpha: ["alpha"] },
      wolfDomains: { alpha: ["alpha", "beta"] },
      kbSync: { fetchImpl: (async (u: string, init?: RequestInit) => (urls.push(u), fetch(u, init))) as typeof fetch },
    });
    await r.waitPresence("online");
    await r.kbWrite("alpha", `entries/${E1}.md`, entry(E1));
    await r.eventually(() => r.mirrored("alpha", `entries/${E1}.md`) !== undefined, "alpha mirrored");
    r.workerd.kbSync!.notify("beta", 5, "e");
    await r.workerd.kbSync!.idle();
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.some((u) => u.includes("/domains/beta/"))).toBe(false);
  });

  it("nothing is subscribed before the first welcome", async () => {
    const r = await rig({ noHub: true, kbDomains: ["alpha"], grants: { alpha: ["alpha"] } });
    const a = direct(r, ["alpha"]);
    const early = new KbSync({ hubUrl: r.hub.url, token: r.token, mirrorDir: a.mirrorDir, pollMs: 0 });
    cleanup.push(() => early.stop());
    early.start();
    expect(early.status()).toEqual({});
  });

  it("symlinked directories are never written or deleted through", async () => {
    const r = await rig({ kbDomains: ["alpha"], grants: { alpha: ["alpha"] } });
    await r.kbWrite("alpha", `entries/${E1}.md`, entry(E1));
    await online(r);
    const outside = tmpDir();
    writeFileSync(join(outside, `${E2}.md`), "outside, must survive");
    const dir = tmpDir();
    mkdirSync(join(dir, "alpha"), { recursive: true });
    symlinkSync(outside, join(dir, "alpha", "entries"));
    const a = direct(r, ["alpha"], {}, dir);
    a.sync.start();
    await r.eventually(() => (a.sync.status().alpha?.failures ?? 0) >= 2, "refusals");
    expect(a.sync.status().alpha!.lastError).toMatch(/symlink/);
    expect(readdirSync(outside)).toEqual([`${E2}.md`]);
    expect(readFileSync(join(outside, `${E2}.md`), "utf8")).toBe("outside, must survive");
  });

  it("verify on start repairs deleted and corrupted mirror files", async () => {
    const r = await rig({ kbDomains: ["alpha"], grants: { alpha: ["alpha"] } });
    await r.kbWrite("alpha", `entries/${E1}.md`, entry(E1));
    await r.kbWrite("alpha", `entries/${E2}.md`, entry(E2));
    await online(r);
    const a = direct(r, ["alpha"]);
    a.sync.start();
    await settle(r, a.sync, "alpha", 2);
    a.sync.stop();
    rmSync(join(a.mirrorDir, "alpha", "entries", `${E1}.md`));
    writeFileSync(join(a.mirrorDir, "alpha", "entries", `${E2}.md`), "corrupt");
    const b = direct(r, ["alpha"], {}, a.mirrorDir);
    b.sync.start();
    await r.eventually(() => readFileSync(join(a.mirrorDir, "alpha", "entries", `${E2}.md`), "utf8") === entry(E2) && existsSync(join(a.mirrorDir, "alpha", "entries", `${E1}.md`)), "repaired");
    expect(b.urls.some((u) => u.includes("manifest-diff"))).toBe(true);
  });

  it("a corrupt state file falls back to a manifest diff", async () => {
    const r = await rig({ kbDomains: ["alpha"], grants: { alpha: ["alpha"] } });
    await r.kbWrite("alpha", `entries/${E1}.md`, entry(E1));
    await online(r);
    const a = direct(r, ["alpha"]);
    a.sync.start();
    await settle(r, a.sync, "alpha", 1);
    a.sync.stop();
    writeFileSync(join(a.mirrorDir, ".sync", "alpha.json"), "{not json");
    const b = direct(r, ["alpha"], { verifyOnStart: false }, a.mirrorDir);
    b.sync.start();
    await settle(r, b.sync, "alpha", 1);
    expect(b.urls.some((u) => u.includes("manifest-diff"))).toBe(true);
    expect(stateOf(a.mirrorDir, "alpha").rev).toBe(1);
  });

  it("manifest-diff pending pages across several rounds", async () => {
    const r = await rig({ kbDomains: ["alpha"], grants: { alpha: ["alpha"] } });
    const ids = ["kb-alpha-1111111", "kb-alpha-2222222", "kb-alpha-3333333", "kb-alpha-4444444"];
    for (const id of ids) await r.kbWrite("alpha", `entries/${id}.md`, entry(id));
    await online(r);
    const a = direct(r, ["alpha"], { maxBytes: 1 });
    a.sync.start();
    await settle(r, a.sync, "alpha", 4);
    expect(a.urls.filter((u) => u.includes("manifest-diff")).length).toBeGreaterThanOrEqual(4);
    for (const id of ids) expect(readFileSync(join(a.mirrorDir, "alpha", "entries", `${id}.md`), "utf8")).toBe(entry(id));
  });

  it("overlapping triggers coalesce into one extra pass", async () => {
    const r = await rig({ kbDomains: ["alpha"], grants: { alpha: ["alpha"] } });
    await r.kbWrite("alpha", `entries/${E1}.md`, entry(E1));
    await online(r);
    const a = direct(r, ["alpha"]);
    a.sync.start();
    await settle(r, a.sync, "alpha", 1);
    a.sync.stop();
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    let changes = 0;
    const b = direct(r, ["alpha"], {
      verifyOnStart: false,
      fetchImpl: (async (u: string, init?: RequestInit) => {
        if (u.includes("/changes?")) {
          changes++;
          await gate;
        }
        return fetch(u, init);
      }) as typeof fetch,
    }, a.mirrorDir);
    b.sync.start();
    await r.eventually(() => changes === 1, "first pull in flight");
    for (let i = 0; i < 6; i++) b.sync.notify("alpha", i, "e");
    release();
    await r.eventually(() => !b.sync.status().alpha!.syncing, "idle");
    expect(changes).toBe(2);
  });

  it("kb.changed floods do not bypass the backoff of a failing domain", async () => {
    const r = await rig({ kbDomains: ["alpha"], grants: { alpha: ["alpha"] } });
    await online(r);
    let calls = 0;
    const a = direct(r, ["alpha"], { baseMs: 400, capMs: 400, fetchImpl: (async () => (calls++, new Response("no", { status: 403 }))) as typeof fetch });
    a.sync.start();
    await r.eventually(() => (a.sync.status().alpha?.failures ?? 0) >= 1, "first failure");
    const n = calls;
    for (let i = 0; i < 50; i++) a.sync.notify("alpha", i, "e");
    await a.sync.idle();
    expect(calls).toBe(n);
  });

  it("an in-flight sync neither resets active:true after removal nor writes after stop()", async () => {
    const r = await rig({ kbDomains: ["alpha"], grants: { alpha: ["alpha"] } });
    await r.kbWrite("alpha", `entries/${E1}.md`, entry(E1));
    await online(r);
    const a = direct(r, ["alpha"]);
    a.sync.start();
    await settle(r, a.sync, "alpha", 1);
    a.sync.stop();
    await r.kbWrite("alpha", `entries/${E2}.md`, entry(E2));
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    let waiting = 0;
    const gated = (async (u: string, init?: RequestInit) => {
      waiting++;
      await gate;
      return fetch(u, init);
    }) as typeof fetch;
    const b = direct(r, ["alpha"], { verifyOnStart: false, fetchImpl: gated }, a.mirrorDir);
    b.sync.start();
    await r.eventually(() => waiting === 1, "in flight");
    b.sync.setGranted([]);
    expect(stateOf(a.mirrorDir, "alpha").active).toBe(false);
    release();
    await b.sync.idle();
    expect(stateOf(a.mirrorDir, "alpha")).toMatchObject({ active: false, rev: 1 });
    expect(existsSync(join(a.mirrorDir, "alpha", "entries", `${E2}.md`))).toBe(false);

    // stop() while a page is in flight: nothing lands afterwards
    let release2!: () => void;
    const gate2 = new Promise<void>((res) => (release2 = res));
    let waiting2 = 0;
    const c = direct(r, ["alpha"], { verifyOnStart: false, fetchImpl: (async (u: string, init?: RequestInit) => (waiting2++, await gate2, fetch(u, init))) as typeof fetch }, a.mirrorDir);
    c.sync.start();
    await r.eventually(() => waiting2 === 1, "in flight 2");
    c.sync.stop();
    release2();
    await c.sync.idle();
    expect(existsSync(join(a.mirrorDir, "alpha", "entries", `${E2}.md`))).toBe(false);
  });
});
