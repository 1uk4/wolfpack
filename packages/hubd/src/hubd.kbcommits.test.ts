/** KB commits: validation, CAS, actor policy, kb.changed, ledger-level atomicity (failure injection, crash recovery). */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACTOR_HEADER, type KbChange } from "@wolfpack/protocol";
import { contentHash, ledgerFile } from "@wolfpack/kb/shared";
import { readLedger } from "@wolfpack/kb/librarian";
import { createHubServer, type HubServer } from "./server.js";
import { hubRoots } from "./layout.js";
import { applyKbCommit, acquireKbWriterLock, kbJournalFile, recoverKbCommit } from "./kb-commits.js";

const KEY = "k";
const OP = { id: "1uk4", kind: "operator" } as const;
const SYS = { id: "system", kind: "system" } as const;
const WOLF = { id: "w1", kind: "wolf" } as const;
const tmp: string[] = [];
const servers: HubServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
});

const entry = (domain: string, id: string, title = "T", body = "Body text.\n") => `---\nid: ${id}\ntitle: "${title}"\ndomain: ${domain}\n---\n\n# ${title}\n\n${body}`;
const ID1 = "kb-alpha-aaaaaaa";
const ID2 = "kb-alpha-bbbbbbb";
const create = (domain: string, id: string, content = entry(domain, id)): KbChange => ({ op: "create", domain, path: `entries/${id}.md`, content, contentHash: contentHash(content), prevHash: null });
const update = (domain: string, id: string, prev: string, content: string): KbChange => ({ op: "update", domain, path: `entries/${id}.md`, content, contentHash: contentHash(content), prevHash: contentHash(prev) });

async function setup(kbFaults?: Parameters<typeof createHubServer>[0]["kbFaults"]) {
  const dir = mkdtempSync(join(tmpdir(), "hubd-kb-"));
  tmp.push(dir);
  const base = join(dir, "kb", "base");
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "domains.yaml"), "domains:\n  alpha:\n    label: Alpha\n  beta:\n    label: Beta\n  wp:\n    label: WP\n");
  const hub = await createHubServer({ dataDir: dir, apiKey: KEY, kbFaults });
  servers.push(hub);
  const post = (body: unknown, actor?: object) =>
    fetch(hub.url + "/v1/kb/commits", { method: "POST", headers: { "X-API-Key": KEY, "Content-Type": "application/json", ...(actor ? { [ACTOR_HEADER]: JSON.stringify(actor) } : {}) }, body: JSON.stringify(body) });
  const file = (d: string, p: string) => join(base, "domains", d, p);
  const ledger = () => (existsSync(ledgerFile(hub.roots)) ? readFileSync(ledgerFile(hub.roots)) : Buffer.alloc(0));
  /** Every file under kb/base/domains, with bytes. */
  const snapshot = () => {
    const out: Record<string, string> = {};
    const walk = (d: string) => {
      for (const e of existsSync(d) ? readdirSync(d, { withFileTypes: true }) : []) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out[p] = readFileSync(p, "base64");
      }
    };
    walk(join(dir, "kb", "base", "domains"));
    return out;
  };
  return { dir, hub, post, file, ledger, snapshot, base };
}

describe("POST /v1/kb/commits", () => {
  it("commits a batch (create, update, delete, registry/digest/INDEX), appends the ledger, emits kb.changed per domain", async () => {
    const s = await setup();
    const events: unknown[] = [];
    const ctl = new AbortController();
    const sse = await fetch(s.hub.url + "/v1/events", { headers: { "X-API-Key": KEY }, signal: ctl.signal });
    const reader = sse.body!.getReader();
    const pump = (async () => {
      const dec = new TextDecoder();
      try {
        for (;;) {
          const r = await reader.read();
          if (r.done) return;
          for (const m of dec.decode(r.value).matchAll(/^data: (.*)$/gm)) events.push(JSON.parse(m[1]));
        }
      } catch { /* aborted */ }
    })();
    const r1 = await s.post({ changes: [create("alpha", ID1), create("alpha", ID2), create("beta", "kb-beta-ccccccc"), { op: "create", domain: "alpha", path: "INDEX.md", content: "# idx\n", contentHash: contentHash("# idx\n"), prevHash: null }, { op: "create", domain: "alpha", path: "_digest.json", content: "{}", contentHash: contentHash("{}"), prevHash: null }] }, OP);
    expect(r1.status).toBe(200);
    const out = await r1.json();
    expect(out).toMatchObject({ committed: 5, entryIds: [ID1, ID2, "kb-beta-ccccccc"], domains: ["alpha", "beta"] });
    expect(readFileSync(s.file("alpha", `entries/${ID1}.md`), "utf8")).toBe(entry("alpha", ID1));
    const v2 = entry("alpha", ID1, "T2");
    const r2 = await s.post({ changes: [update("alpha", ID1, entry("alpha", ID1), v2), { op: "delete", domain: "alpha", path: `entries/${ID2}.md`, contentHash: null, prevHash: contentHash(entry("alpha", ID2)) }] }, OP);
    expect(r2.status).toBe(200);
    expect(existsSync(s.file("alpha", `entries/${ID2}.md`))).toBe(false);
    const led = readLedger(s.hub.roots);
    expect(led.map((e) => e.t)).toEqual(["entry_written", "entry_written", "entry_written", "entry_written", "entry_retired"]);
    expect(led[3]).toMatchObject({ entryId: ID1, action: "merge" });
    await new Promise((r) => setTimeout(r, 200));
    ctl.abort();
    await pump;
    const kb = (events as { type: string; entryIds?: string[]; domain?: string }[]).filter((e) => e.type === "kb.changed");
    expect(kb).toEqual([
      expect.objectContaining({ entryIds: [ID1, ID2], domain: "alpha" }),
      expect.objectContaining({ entryIds: ["kb-beta-ccccccc"], domain: "beta" }),
      expect.objectContaining({ entryIds: [ID1, ID2], domain: "alpha" }), // the second batch: one event per domain
    ]);
  });

  it("a stale prevHash is 409 conflict and the whole batch (files + ledger) is untouched", async () => {
    const s = await setup();
    await s.post({ changes: [create("alpha", ID1)] }, OP);
    const before = { snap: s.snapshot(), led: s.ledger() };
    const res = await s.post({ changes: [create("alpha", ID2), update("alpha", ID1, "stale text", entry("alpha", ID1, "X"))] }, OP);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "conflict", details: { path: `alpha/entries/${ID1}.md` } });
    expect(s.snapshot()).toEqual(before.snap);
    expect(s.ledger().equals(before.led)).toBe(true);
    // creating over an existing file (prevHash null) is stale too
    expect((await s.post({ changes: [create("alpha", ID1)] }, OP)).status).toBe(409);
  });

  it("rejects an invalid entry, an undeclared domain, a bad contentHash and escaping paths, leaving everything untouched", async () => {
    const s = await setup();
    const before = { snap: s.snapshot(), led: s.ledger() };
    const good = create("alpha", ID1);
    const cases: KbChange[] = [
      create("alpha", ID2, "no frontmatter"),
      create("alpha", ID2, entry("beta", ID2)), // domain mismatch
      create("alpha", ID2, entry("alpha", ID1)), // id != file name
      create("gamma", "kb-gamma-aaaaaaa"), // undeclared
      { ...create("alpha", ID2), contentHash: contentHash("other") },
      { op: "create", domain: "alpha", path: "../beta/INDEX.md", content: "x", contentHash: contentHash("x"), prevHash: null } as KbChange,
      { op: "create", domain: "alpha", path: "/etc/passwd", content: "x", contentHash: contentHash("x"), prevHash: null } as KbChange,
      { op: "create", domain: "alpha", path: "entries/../x.md", content: "x", contentHash: contentHash("x"), prevHash: null } as KbChange,
      { op: "create", domain: "alpha", path: "work/x.md", content: "x", contentHash: contentHash("x"), prevHash: null } as KbChange,
      { op: "create", domain: "../alpha", path: "INDEX.md", content: "x", contentHash: contentHash("x"), prevHash: null },
      { op: "create", domain: "alpha", path: "_digest.json", content: "[not json", contentHash: contentHash("[not json"), prevHash: null },
      { op: "create", domain: "alpha", path: "_digest.json", content: "null", contentHash: contentHash("null"), prevHash: null },
      { op: "create", domain: "alpha", path: "_digest.json", content: "[1]", contentHash: contentHash("[1]"), prevHash: null },
      create("wp", "kb-wp-foo-aaaaaaa"), // the id's domain part must be exactly the declared domain
      create("alpha", "kb-alpha-AAAAAAA"), // case-insensitive collision with ID1 in the same batch
    ];
    for (const bad of cases) {
      const res = await s.post({ changes: [good, bad] }, OP);
      expect(res.status, JSON.stringify(bad).slice(0, 80)).toBe(400);
    }
    expect((await s.post({ changes: [good, good] }, OP)).status).toBe(400); // duplicate path
    expect(s.snapshot()).toEqual(before.snap);
    expect(s.ledger().equals(before.led)).toBe(true);
  });

  it("refuses a symlinked domain directory", async () => {
    const s = await setup();
    const outside = mkdtempSync(join(tmpdir(), "hubd-kb-out-"));
    tmp.push(outside);
    mkdirSync(join(s.base, "domains"), { recursive: true });
    symlinkSync(outside, join(s.base, "domains", "alpha"));
    expect((await s.post({ changes: [create("alpha", ID1)] }, OP)).status).toBe(400);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("refuses a symlinked directory or file as a write target", async () => {
    const s = await setup();
    const outside = mkdtempSync(join(tmpdir(), "hubd-kb-out-"));
    tmp.push(outside);
    mkdirSync(join(s.base, "domains", "alpha"), { recursive: true });
    symlinkSync(outside, join(s.base, "domains", "alpha", "entries"));
    expect((await s.post({ changes: [create("alpha", ID1)] }, OP)).status).toBe(400);
    expect(readdirSync(outside)).toEqual([]);
    rmSync(join(s.base, "domains", "alpha", "entries"));
    writeFileSync(join(outside, "t"), "secret");
    symlinkSync(join(outside, "t"), join(s.base, "domains", "alpha", "INDEX.md"));
    const cur = "secret";
    expect((await s.post({ changes: [{ op: "update", domain: "alpha", path: "INDEX.md", content: "x", contentHash: contentHash("x"), prevHash: contentHash(cur) }] }, OP)).status).toBe(400);
    expect(readFileSync(join(outside, "t"), "utf8")).toBe("secret");
  });

  it("actor policy: wolf 403 forbidden, no actor 400, system cannot be asserted over HTTP; in-process commitKb allows system and operator", async () => {
    const s = await setup();
    const body = { changes: [create("alpha", ID1)] };
    expect((await s.post(body, WOLF)).status).toBe(403);
    expect(await (await s.post(body, WOLF)).json()).toMatchObject({ code: "forbidden" });
    expect((await s.post(body)).status).toBe(400);
    expect((await s.post(body, SYS)).status).toBe(400);
    expect(existsSync(s.file("alpha", `entries/${ID1}.md`))).toBe(false);
    await expect(s.hub.commitKb(WOLF, body)).rejects.toMatchObject({ code: "forbidden" });
    await expect(s.hub.commitKb(SYS, body)).resolves.toMatchObject({ committed: 1 });
    await expect(s.hub.commitKb(OP, { changes: [create("alpha", ID2)] })).resolves.toMatchObject({ committed: 1 });
  });

  it("rejects malformed bodies (400) and bodies over the 8 MiB cap", async () => {
    const s = await setup();
    expect((await s.post({ changes: [] }, OP)).status).toBe(400);
    expect((await s.post({ changes: [{ op: "create", domain: "alpha", path: "INDEX.md" }] }, OP)).status).toBe(400);
    expect((await s.post({ changes: [create("alpha", ID1)], extra: 1 }, OP)).status).toBe(400);
    const big = "x".repeat(9 * 1024 * 1024);
    const res = await s.post({ changes: [{ op: "create", domain: "alpha", path: "INDEX.md", content: big, contentHash: contentHash(big), prevHash: null }] }, OP);
    expect(res.status).toBe(400);
  });
});

describe("in-process commitKb validates the request", () => {
  it("bad prevHash, a missing field and more than 500 changes are invalid_request", async () => {
    const s = await setup();
    const c = create("alpha", ID1);
    await expect(s.hub.commitKb(SYS, { changes: [{ ...c, prevHash: "nope" }] } as never)).rejects.toMatchObject({ code: "invalid_request" });
    const { content: _c, ...noContent } = c as KbChange & { content: string };
    await expect(s.hub.commitKb(SYS, { changes: [noContent] } as never)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(s.hub.commitKb(OP, { changes: Array.from({ length: 501 }, () => c) })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(s.hub.commitKb(OP, {} as never)).rejects.toMatchObject({ code: "invalid_request" });
    expect(existsSync(s.file("alpha", `entries/${ID1}.md`))).toBe(false);
  });
});

describe("ledger-level atomicity", () => {
  const batch = (): KbChange[] => [create("alpha", ID1), create("alpha", ID2), { op: "create", domain: "alpha", path: "INDEX.md", content: "# i\n", contentHash: contentHash("# i\n"), prevHash: null }];

  for (const stage of ["journal", "file:0", "file:1", "file:2", "ledger", "journal-drop"]) {
    it(`an in-process failure at ${stage} rolls everything back (files, ledger, journal)`, async () => {
      let fail = false;
      const s = await setup({ at: (st) => { if (fail && st === stage) throw new Error("injected"); } });
      // a pre-existing entry + ledger content that must survive byte-for-byte
      await s.post({ changes: [create("beta", "kb-beta-ccccccc")] }, OP);
      const prior = entry("alpha", "kb-alpha-ddddddd");
      await s.post({ changes: [create("alpha", "kb-alpha-ddddddd", prior)] }, OP);
      const before = { snap: s.snapshot(), led: s.ledger() };
      fail = true;
      const res = await s.post({ changes: [...batch(), update("alpha", "kb-alpha-ddddddd", prior, entry("alpha", "kb-alpha-ddddddd", "changed"))] }, OP);
      expect(res.status).toBe(502);
      expect(s.snapshot()).toEqual(before.snap);
      expect(s.ledger().equals(before.led)).toBe(true);
      expect(existsSync(kbJournalFile(s.dir))).toBe(false);
      fail = false;
      expect((await s.post({ changes: batch() }, OP)).status).toBe(200); // the writer still works
    });
  }

  for (const stage of ["file:1", "ledger", "journal-drop"]) {
    it(`a crash at ${stage} is rolled back by startup recovery`, () => {
      const dir = mkdtempSync(join(tmpdir(), "hubd-kb-crash-"));
      tmp.push(dir);
      const roots = hubRoots(dir);
      mkdirSync(roots.kbBase, { recursive: true });
      mkdirSync(join(dir, "run"), { recursive: true });
      writeFileSync(join(roots.kbBase, "domains.yaml"), "domains:\n  alpha: {}\n");
      const prior = entry("alpha", ID1);
      applyKbCommit(roots, dir, { changes: [create("alpha", ID1, prior)] });
      const snap = () => ({ f: readFileSync(join(roots.kbBase, "domains/alpha/entries", `${ID1}.md`), "base64"), has2: existsSync(join(roots.kbBase, "domains/alpha/entries", `${ID2}.md`)), led: readFileSync(ledgerFile(roots), "base64") });
      const before = snap();
      expect(() =>
        applyKbCommit(roots, dir, { changes: [update("alpha", ID1, prior, entry("alpha", ID1, "new")), create("alpha", ID2)] }, {
          crash: true,
          at: (st) => { if (st === stage) throw new Error("crash"); },
        }),
      ).toThrow();
      expect(existsSync(kbJournalFile(dir))).toBe(true);
      expect(snap()).not.toEqual(before); // the crash left a partial batch
      // a restarting hub takes the lock and recovers
      expect(recoverKbCommit(roots, dir)).toBe(true);
      expect(snap()).toEqual(before);
      expect(existsSync(kbJournalFile(dir))).toBe(false);
      expect(recoverKbCommit(roots, dir)).toBe(false);
    });
  }

  it("a hub restart over a crashed batch recovers it before serving", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hubd-kb-restart-"));
    tmp.push(dir);
    const roots = hubRoots(dir);
    mkdirSync(roots.kbBase, { recursive: true });
    writeFileSync(join(roots.kbBase, "domains.yaml"), "domains:\n  alpha: {}\n");
    expect(() => applyKbCommit(roots, dir, { changes: [create("alpha", ID1)] }, { crash: true, at: (st) => { if (st === "ledger") throw new Error("crash"); } })).toThrow();
    expect(existsSync(join(roots.kbBase, "domains/alpha/entries", `${ID1}.md`))).toBe(true);
    const hub = await createHubServer({ dataDir: dir, apiKey: KEY });
    servers.push(hub);
    expect(existsSync(join(roots.kbBase, "domains/alpha/entries", `${ID1}.md`))).toBe(false);
    expect(existsSync(kbJournalFile(dir))).toBe(false);
  });

  it("the KB writer lock admits one holder and recovers a dead owner's lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "hubd-kb-lock-"));
    tmp.push(dir);
    const a = acquireKbWriterLock(dir);
    expect(() => acquireKbWriterLock(dir)).toThrow(/already has a writer/);
    a.release();
    acquireKbWriterLock(dir).release();
    mkdirSync(join(dir, "run"), { recursive: true });
    writeFileSync(join(dir, "run", "kb-writer.lock"), JSON.stringify({ pid: 2 ** 22 + 12345 }));
    acquireKbWriterLock(dir).release();
  });

  it("a failed rollback poisons the writer, the journal stays untouched, and a restart recovers byte-identical", async () => {
    let mode: "off" | "both" = "off";
    const s = await setup({ at: (st) => { if (mode === "both" && (st === "file:1" || st === "rollback")) throw new Error("injected"); } });
    const prior = entry("alpha", ID1);
    await s.post({ changes: [create("alpha", ID1, prior)] }, OP);
    const before = { snap: s.snapshot(), led: s.ledger() };
    mode = "both";
    const res = await s.post({ changes: [update("alpha", ID1, prior, entry("alpha", ID1, "new")), create("alpha", ID2), create("alpha", "kb-alpha-eeeeeee")] }, OP);
    expect(res.status).toBe(502);
    const msg = ((await res.json()) as { message: string }).message;
    expect(msg).toMatch(/restart/);
    expect(msg).not.toMatch(/was rolled back/);
    const jf = kbJournalFile(s.dir);
    const journalBytes = readFileSync(jf);
    const partial = s.snapshot();
    expect(partial).not.toEqual(before.snap);
    mode = "off";
    const next = await s.post({ changes: [create("alpha", "kb-alpha-fffffff")] }, OP);
    expect(next.status).toBe(502);
    expect(((await next.json()) as { message: string }).message).toMatch(/restart/);
    expect(readFileSync(jf).equals(journalBytes)).toBe(true);
    expect(s.snapshot()).toEqual(partial);
    await servers.pop()!.close();
    const hub2 = await createHubServer({ dataDir: s.dir, apiKey: KEY });
    servers.push(hub2);
    expect(s.snapshot()).toEqual(before.snap);
    expect(readFileSync(ledgerFile(hub2.roots)).equals(before.led)).toBe(true);
    expect(existsSync(jf)).toBe(false);
  });

  it("a journal already on disk makes applyKbCommit refuse (never overwritten)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hubd-kb-jr-"));
    tmp.push(dir);
    const roots = hubRoots(dir);
    mkdirSync(join(dir, "run"), { recursive: true });
    mkdirSync(roots.kbBase, { recursive: true });
    writeFileSync(join(roots.kbBase, "domains.yaml"), "domains:\n  alpha: {}\n");
    writeFileSync(kbJournalFile(dir), "{\"keep\":1}");
    expect(() => applyKbCommit(roots, dir, { changes: [create("alpha", ID1)] })).toThrow(/awaiting recovery/);
    expect(readFileSync(kbJournalFile(dir), "utf8")).toBe("{\"keep\":1}");
  });

  it("rollback does not cut a ledger append made after ours", async () => {
    let fail = false;
    const s = await setup({
      at: (st) => {
        if (!fail || st !== "journal-drop") return;
        appendFileSync(ledgerFile(hubRoots(s.dir)), JSON.stringify({ t: "subscribed", id: "x", at: "2026-01-01 00:00", wolf: "w", canonicalId: "c" }) + "\n");
        throw new Error("injected");
      },
    });
    const before = s.ledger();
    fail = true;
    expect((await s.post({ changes: [create("alpha", ID1)] }, OP)).status).toBe(502);
    expect(existsSync(s.file("alpha", `entries/${ID1}.md`))).toBe(false); // files rolled back
    const after = s.ledger();
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.toString("utf8")).toMatch(/"entry_written"[\s\S]*"subscribed"/); // ours and the later append both stay
    expect(after.toString("utf8").trim().split("\n").pop()).toContain('"subscribed"');
  });

  it("recovery sweeps stale *.tmp-* files of the touched domain", () => {
    const dir = mkdtempSync(join(tmpdir(), "hubd-kb-tmp-"));
    tmp.push(dir);
    const roots = hubRoots(dir);
    mkdirSync(roots.kbBase, { recursive: true });
    writeFileSync(join(roots.kbBase, "domains.yaml"), "domains:\n  alpha: {}\n");
    expect(() => applyKbCommit(roots, dir, { changes: [create("alpha", ID1)] }, { crash: true, at: (st) => { if (st === "ledger") throw new Error("crash"); } })).toThrow();
    const stale = join(roots.kbBase, "domains/alpha/entries", `${ID2}.md.tmp-123-deadbeef`);
    writeFileSync(stale, "partial");
    expect(recoverKbCommit(roots, dir)).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });

  it("lock takeover: a live lock that slips in between judging and moving is put back, not deleted", () => {
    const dir = mkdtempSync(join(tmpdir(), "hubd-kb-race-"));
    tmp.push(dir);
    mkdirSync(join(dir, "run"), { recursive: true });
    const lock = join(dir, "run", "kb-writer.lock");
    writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345 }));
    const live = JSON.stringify({ pid: process.pid, startedAt: "live" });
    expect(() =>
      acquireKbWriterLock(dir, process.pid, {
        afterJudgedStale: () => {
          writeFileSync(`${lock}.new`, live);
          renameSync(`${lock}.new`, lock); // another contender took the stale lock over first
        },
      }),
    ).toThrow(/already has a writer/);
    expect(readFileSync(lock, "utf8")).toBe(live);
  });

  it("a failed start releases both locks: an immediate same-process restart succeeds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hubd-kb-start-"));
    tmp.push(dir);
    const blocker = netServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
    const port = (blocker.address() as { port: number }).port;
    await expect(createHubServer({ dataDir: dir, apiKey: KEY, port })).rejects.toThrow();
    blocker.close();
    expect(existsSync(join(dir, "run", "kb-writer.lock"))).toBe(false);
    const hub = await createHubServer({ dataDir: dir, apiKey: KEY });
    servers.push(hub);
  });
});
