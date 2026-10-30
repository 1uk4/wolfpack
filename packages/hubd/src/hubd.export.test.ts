/** hubd export / import: round trip, served reads, and every refusal. */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACTOR_HEADER } from "@wolfpack/protocol";
import { contentHash } from "@wolfpack/kb/shared";
import { createHubServer, type HubServer } from "./server.js";
import { exportHub, importHub, type ExportManifest } from "./export.js";
import { readTar, writeTar, type TarEntry } from "./tar.js";
import { main, parseArgs } from "./cli.js";
import { kbJournalFile } from "./kb-commits.js";
import { seedFixture } from "./testing/fixture.js";

const KEY = "k";
const OP = { [ACTOR_HEADER]: JSON.stringify({ id: "1uk4", kind: "operator" }) };
const tmp: string[] = [];
const servers: HubServer[] = [];
const mk = () => {
  const d = mkdtempSync(join(tmpdir(), "hubd-export-"));
  tmp.push(d);
  return d;
};
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
});

function tree(root: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const walk = (rel: string) => {
    for (const n of readdirSync(join(root, rel)).sort()) {
      const p = rel ? `${rel}/${n}` : n;
      if (lstatSync(join(root, p)).isDirectory()) {
        out[p] = null;
        walk(p);
      } else out[p] = readFileSync(join(root, p)).toString("base64");
    }
  };
  walk("");
  return out;
}

const entry = (id: string) => `---\nid: ${id}\ntitle: "T"\ndomain: wolfpack\n---\n\n# T\n\nBody.\n`;

async function seed() {
  const dir = mk();
  const src = mk();
  writeFileSync(join(src, "domains.yaml"), "domains:\n  wolfpack:\n    label: Wolfpack\n    description: The pack\n    created: 2026-01-03\n");
  writeFileSync(join(src, "a.yaml"), "name: alpha\ndomains: [wolfpack]\n");
  const seeded = seedFixture(dir);
  const hub = await createHubServer({ dataDir: dir, apiKey: KEY, registrySeed: { domainsYaml: join(src, "domains.yaml"), wolfYamls: [join(src, "a.yaml")] } });
  const call = (h: HubServer, method: string, path: string, body?: unknown, hdr: Record<string, string> = OP) =>
    fetch(h.url + path, { method, headers: { "X-API-Key": KEY, "Content-Type": "application/json", ...hdr }, body: body === undefined ? undefined : JSON.stringify(body) });
  // work: stage + claim
  await call(hub, "PATCH", `/v1/work/${seeded.tasks[0]}`, { stage: "approved" });
  const claim = await call(hub, "POST", `/v1/work/${seeded.tasks[0]}/claim`, undefined, { [ACTOR_HEADER]: JSON.stringify({ id: "alpha", kind: "wolf" }) });
  expect(claim.status).toBe(200);
  // KB commit
  const id = "kb-wolfpack-aaaaaaa";
  const content = entry(id);
  const kb = await call(hub, "POST", "/v1/kb/commits", { changes: [{ op: "create", domain: "wolfpack", path: `entries/${id}.md`, content, contentHash: contentHash(content), prevHash: null }] });
  expect(kb.status).toBe(200);
  // contribution + processed + bad
  const body = "The body.";
  const c = await call(hub, "POST", "/v1/contributions", {
    from: "alpha", denTopicId: "topic-a", change: "create", contentHash: contentHash(body), prevHash: null, domainHint: "wolfpack",
    summary: "S.", submitted: "2026-10-01 12:00", body, origin: "crawl", sourcePath: "/src",
  }, { [ACTOR_HEADER]: JSON.stringify({ id: "alpha", kind: "wolf" }) });
  expect(c.status).toBe(201);
  const lane = join(dir, "kb", "ops", "contributions", "alpha");
  mkdirSync(join(lane, "_processed"), { recursive: true });
  mkdirSync(join(lane, "_bad"), { recursive: true });
  writeFileSync(join(lane, "_processed", "old-1.md"), "processed\n");
  writeFileSync(join(lane, "_bad", "bad-1.md"), "bad\n");
  writeFileSync(join(lane, "_bad", "bad-1.reason.txt"), "why\n");
  const reads = async (h: HubServer) => {
    const list = await (await call(h, "GET", "/v1/work")).text();
    const items = await Promise.all([seeded.feature.id, ...seeded.tasks, seeded.graduated].map(async (i) => (await call(h, "GET", `/v1/work/${i}`)).text()));
    return { list, items };
  };
  const before = await reads(hub);
  await hub.close();
  return { dir, seeded, reads, before, call };
}

const rewrite = (file: string, f: (e: TarEntry[]) => TarEntry[]) => writeFileSync(file, writeTar(f(readTar(readFileSync(file)))));
const withManifest = (e: TarEntry[], f: (m: ExportManifest) => void) => {
  const m = JSON.parse(e[0]!.data.toString()) as ExportManifest;
  f(m);
  return [{ ...e[0]!, data: Buffer.from(JSON.stringify(m)) }, ...e.slice(1)];
};

describe("hubd export / import", () => {
  it("round-trips byte-identically and the imported hub serves the same work reads", async () => {
    const s = await seed();
    const out = join(mk(), "hub.tar");
    const { manifest, skipped } = exportHub({ dataDir: s.dir, out });
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.lastEventSequence).toBe(readFileSync(join(s.dir, "ledger", "work-events.jsonl"), "utf8").trim().split("\n").length);
    expect(manifest.kbLedgerLines).toBe(1);
    expect(readTar(readFileSync(out))[0]!.path).toBe("manifest.json");
    expect(manifest.files.map((f) => f.path)).toEqual(expect.arrayContaining(["registry/registry.json", "ledger/events.jsonl", "kb/base/domains.yaml", "kb/ops/contributions/alpha/_bad/bad-1.md", "kb/ops/contributions/alpha/_processed/old-1.md"]));
    expect(skipped).toEqual(expect.arrayContaining(["run"]));
    expect(manifest.files.some((f) => f.path.startsWith("run/") || f.path.startsWith("tmp/"))).toBe(false);
    // deterministic bytes apart from createdAt
    const out2 = join(mk(), "hub2.tar");
    exportHub({ dataDir: s.dir, out: out2, now: () => new Date(manifest.createdAt) });
    expect(readFileSync(out2).equals(readFileSync(out))).toBe(true);

    const target = join(mk(), "imported");
    importHub({ dataDir: target, in: out });
    const a = tree(s.dir);
    for (const k of Object.keys(a)) if (k === "run" || k.startsWith("run/") || k === "tmp" || k.startsWith("tmp/")) delete a[k];
    expect(tree(target)).toEqual(a);

    const hub = await createHubServer({ dataDir: target, apiKey: KEY });
    servers.push(hub);
    const after = await s.reads(hub);
    expect(after).toEqual(s.before);
  });

  it("imports into an existing empty directory", async () => {
    const s = await seed();
    const out = join(mk(), "hub.tar");
    exportHub({ dataDir: s.dir, out });
    const target = mk();
    importHub({ dataDir: target, in: out });
    expect(existsSync(join(target, "ledger", "work-events.jsonl"))).toBe(true);
  });

  it("refuses a non-empty target and leaves it alone", async () => {
    const s = await seed();
    const out = join(mk(), "hub.tar");
    exportHub({ dataDir: s.dir, out });
    const target = mk();
    writeFileSync(join(target, "keep.txt"), "x");
    expect(() => importHub({ dataDir: target, in: out })).toThrow(/not empty/);
    expect(readdirSync(target)).toEqual(["keep.txt"]);
  });

  it("a tampered file, a missing manifest entry, a traversal entry, an unknown entry and a bad version all leave the target untouched", async () => {
    const s = await seed();
    const good = join(mk(), "hub.tar");
    exportHub({ dataDir: s.dir, out: good });
    const bad = (name: string, f: (e: TarEntry[]) => TarEntry[], re: RegExp) => {
      const file = join(mk(), `${name}.tar`);
      writeFileSync(file, readFileSync(good));
      rewrite(file, f);
      const parent = mk();
      const target = join(parent, "t");
      expect(() => importHub({ dataDir: target, in: file }), name).toThrow(re);
      expect(readdirSync(parent), name).toEqual([]); // no target, no temp dir
    };
    bad("tamper", (e) => e.map((x) => (x.path === "registry/registry.json" ? { ...x, data: Buffer.from(x.data.toString() + " ") } : x)), /size mismatch|hash mismatch/);
    bad("tamper-same-size", (e) => e.map((x) => (x.path === "ledger/events.jsonl" ? { ...x, data: Buffer.from(x.data.toString().replace("{", "[")) } : x)), /hash mismatch/);
    bad("unlisted", (e) => [...e, { path: "kb/base/extra.md", type: "file", data: Buffer.from("x") }], /not in the manifest/);
    bad("missing", (e) => e.filter((x) => x.path !== "registry/registry.json"), /missing from the archive/);
    bad("traversal", (e) => withManifest(e, (m) => m.files.push({ path: "kb/base/../../evil", size: 1, sha256: "0" })).concat([{ path: "kb/base/../../evil", type: "file", data: Buffer.from("x") }]), /unsafe path/);
    bad("absolute", (e) => [...e, { path: "/etc/evil", type: "file", data: Buffer.from("x") }], /unsafe path/);
    bad("outside-roots", (e) => withManifest(e, (m) => m.files.push({ path: "run/work-server.lock", size: 0, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" })), /disallowed/);
    bad("version", (e) => withManifest(e, (m) => (m.formatVersion = 2)), /formatVersion/);
    bad("no-manifest-first", (e) => [...e.slice(1), e[0]!], /first tar entry/);
    // a link entry (typeflag 2) is refused by the reader
    const link = join(mk(), "link.tar");
    const t = Buffer.from(readFileSync(good));
    t[156] = "2".charCodeAt(0);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : t[i]!;
    t.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    writeFileSync(link, t);
    expect(() => importHub({ dataDir: join(mk(), "t"), in: link })).toThrow(/unsupported type/);
  });

  it("export refuses while a hub holds the lock, and with a leftover KB journal", async () => {
    const s = await seed();
    const hub = await createHubServer({ dataDir: s.dir, apiKey: KEY });
    servers.push(hub);
    const out = join(mk(), "hub.tar");
    expect(() => exportHub({ dataDir: s.dir, out })).toThrow(/stop it first/);
    expect(existsSync(out)).toBe(false);
    await hub.close();
    servers.pop();
    mkdirSync(join(s.dir, "run"), { recursive: true });
    writeFileSync(kbJournalFile(s.dir), "{}");
    expect(() => exportHub({ dataDir: s.dir, out })).toThrow(/unrecovered KB commit batch/);
    rmSync(kbJournalFile(s.dir));
    exportHub({ dataDir: s.dir, out }); // locks were released by the refusals
    expect(existsSync(out)).toBe(true);
    expect(() => exportHub({ dataDir: s.dir, out })).toThrow(/already exists/);
  });

  it("export refuses a symlink in the source", async () => {
    const s = await seed();
    symlinkSync("/etc/hosts", join(s.dir, "kb", "base", "link.md"));
    expect(() => exportHub({ dataDir: s.dir, out: join(mk(), "x.tar") })).toThrow(/symlink/);
  });

  it("CLI: export and import, non-zero (throws) on refusal", async () => {
    const s = await seed();
    const out = join(mk(), "cli.tar");
    const log: string[] = [];
    await main(["export", "--data-dir", s.dir, "--out", out], {}, (m) => log.push(m));
    const target = join(mk(), "t");
    await main(["import", "--data-dir", target, "--in", out], {}, (m) => log.push(m));
    expect(log).toHaveLength(2);
    await expect(main(["import", "--data-dir", target, "--in", out], {}, () => {})).rejects.toThrow(/not empty/);
    expect(() => parseArgs(["export", "--data-dir", s.dir])).toThrow(/--out/);
  });
});
