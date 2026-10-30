/** hubd export / import: round trip, served reads, and every refusal. */
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, statSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readWorkLedger } from "@wolfpack/kb/client";
import { ledgerFile } from "@wolfpack/kb/shared";
import { readLedger } from "@wolfpack/kb/librarian";
import { afterEach, describe, expect, it } from "vitest";
import { ACTOR_HEADER } from "@wolfpack/protocol";
import { contentHash } from "@wolfpack/kb/shared";
import { hubRoots } from "./layout.js";
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
    // import gives every KB revision log a NEW epoch (a new lineage); everything else is byte-identical
    const b = tree(target);
    const stateKeys = Object.keys(a).filter((k) => /^kb-rev\/[^/]+\/state\.json$/.test(k));
    expect(stateKeys.length).toBeGreaterThan(0);
    for (const k of stateKeys) {
      const before = JSON.parse(Buffer.from(a[k]!, "base64").toString("utf8"));
      const got = JSON.parse(Buffer.from(b[k]!, "base64").toString("utf8"));
      expect(got.epoch).not.toBe(before.epoch);
      expect({ ...got, epoch: "" }).toEqual({ ...before, epoch: "" });
      delete a[k];
      delete b[k];
    }
    expect(b).toEqual(a);

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

const mode = (p: string) => statSync(p).mode & 0o777;
const fixHeaderSum = (t: Buffer, at = 0) => {
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : t[at + i]!;
  t.write(sum.toString(8).padStart(6, "0") + "\0 ", at + 148, "ascii");
};

describe("hubd export / import hardening", () => {
  it("keeps an existing empty target's mode, writes the tar 0600 and imported files 0644 / dirs 0755", async () => {
    const s = await seed();
    const out = join(mk(), "hub.tar");
    exportHub({ dataDir: s.dir, out });
    expect(mode(out)).toBe(0o600);
    const target = mk();
    chmodSync(target, 0o750);
    importHub({ dataDir: target, in: out });
    expect(mode(target)).toBe(0o750);
    expect(mode(join(target, "ledger", "work-events.jsonl"))).toBe(0o644);
    expect(mode(join(target, "kb", "base"))).toBe(0o755);
    expect(readdirSync(target).some((n) => n.startsWith(".import-"))).toBe(false);
    expect(tree(target)).toEqual(tree(join(mk(), "x") && target));
  });

  it("export refuses a --out that appears after the existence check (dangling symlink), writes nothing", async () => {
    const s = await seed();
    const parent = mk();
    const out = join(parent, "hub.tar");
    symlinkSync(join(parent, "nowhere"), out); // existsSync() is false for it; linkSync() gets EEXIST
    expect(() => exportHub({ dataDir: s.dir, out })).toThrow(/already exists/);
    expect(readdirSync(parent).sort()).toEqual(["hub.tar"]);
    expect(existsSync(join(parent, "nowhere"))).toBe(false);
  });

  it("export refuses an --out inside the data dir, also through a symlinked directory", async () => {
    const s = await seed();
    expect(() => exportHub({ dataDir: s.dir, out: join(s.dir, "x.tar") })).toThrow(/outside the data directory/);
    const links = mk();
    symlinkSync(s.dir, join(links, "alias"));
    expect(() => exportHub({ dataDir: s.dir, out: join(links, "alias", "x.tar") })).toThrow(/outside the data directory/);
    expect(existsSync(join(s.dir, "x.tar"))).toBe(false);
  });

  it("ledger counts match the hub's readers (blank and invalid lines skipped)", async () => {
    const s = await seed();
    const roots = hubRoots(s.dir);
    appendFileSync(join(s.dir, "ledger", "work-events.jsonl"), "\n   \nnot json\n{\"type\":\"bogus\"}\n");
    appendFileSync(ledgerFile(roots), "\ngarbage\n");
    const warn = console.warn;
    console.warn = () => {};
    let w: number, k: number;
    try {
      w = readWorkLedger(roots).length;
      k = readLedger(roots).length;
    } finally {
      console.warn = warn;
    }
    const out = join(mk(), "hub.tar");
    const { manifest } = exportHub({ dataDir: s.dir, out });
    expect(manifest.lastEventSequence).toBe(w);
    expect(manifest.kbLedgerLines).toBe(k);
    importHub({ dataDir: join(mk(), "t"), in: out });
  });

  it("export refuses a partial trailing ledger line (work and KB)", async () => {
    for (const f of ["work-events.jsonl", "events.jsonl"]) {
      const s = await seed();
      appendFileSync(join(s.dir, "ledger", f), '{"type":"work.cre');
      expect(() => exportHub({ dataDir: s.dir, out: join(mk(), "x.tar") }), f).toThrow(/partial line/);
    }
  });

  it("import refuses a ledger line-count mismatch (work and KB)", async () => {
    const s = await seed();
    const good = join(mk(), "hub.tar");
    exportHub({ dataDir: s.dir, out: good });
    for (const [field, re] of [["lastEventSequence", /work ledger line count/], ["kbLedgerLines", /KB ledger line count/]] as const) {
      const file = join(mk(), `${field}.tar`);
      writeFileSync(file, readFileSync(good));
      rewrite(file, (e) => withManifest(e, (m) => ((m as never as Record<string, number>)[field] += 1)));
      const parent = mk();
      expect(() => importHub({ dataDir: join(parent, "t"), in: file })).toThrow(re);
      expect(readdirSync(parent)).toEqual([]);
    }
  });

  it("import refuses duplicate entries and file/dir type confusion", async () => {
    const s = await seed();
    const good = join(mk(), "hub.tar");
    exportHub({ dataDir: s.dir, out: good });
    const bad = (name: string, f: (e: TarEntry[]) => TarEntry[], re: RegExp) => {
      const file = join(mk(), `${name}.tar`);
      writeFileSync(file, readFileSync(good));
      rewrite(file, f);
      const parent = mk();
      expect(() => importHub({ dataDir: join(parent, "t"), in: file }), name).toThrow(re);
      expect(readdirSync(parent), name).toEqual([]);
    };
    bad("dup-file", (e) => [...e, e.find((x) => x.path === "registry/registry.json")!], /duplicate archive entry/);
    bad("dup-dir", (e) => [...e, e.find((x) => x.type === "dir")!], /duplicate archive entry/);
    bad("file-as-dir", (e) => e.map((x) => (x.path === "registry/registry.json" ? { ...x, type: "dir" as const, data: Buffer.alloc(0) } : x)), /not in the manifest/);
    bad("dir-as-file", (e) => e.map((x) => (x.path === "kb/base" ? { ...x, type: "file" as const, data: Buffer.from("x") } : x)), /not in the manifest/);
  });

  it("the CLI exits non-zero on refusal and rejects flags that do not apply", async () => {
    const s = await seed();
    const out = join(mk(), "cli.tar");
    exportHub({ dataDir: s.dir, out });
    const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    const run = (...a: string[]) => spawnSync(process.execPath, [cli, ...a], { encoding: "utf8", env: { PATH: process.env.PATH } });
    const target = join(mk(), "t");
    const ok = run("import", "--data-dir", target, "--in", out);
    expect(ok.status).toBe(0);
    const refused = run("import", "--data-dir", target, "--in", out);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/not empty/);
    const flag = run("export", "--data-dir", s.dir, "--out", join(mk(), "y.tar"), "--port", "99");
    expect(flag.status).toBe(1);
    expect(flag.stderr).toMatch(/does not take --port/);
    expect(run("import", "--data-dir", join(mk(), "z"), "--in", out, "--seed-domains", "x").status).toBe(1);
  });

  it("names the offending path when a component exceeds the ustar limit", () => {
    const long = `kb/base/${"a".repeat(101)}`;
    expect(() => writeTar([{ path: long, type: "file", data: Buffer.from("x") }])).toThrow(new RegExp(`ustar.*${"a".repeat(101)}`));
  });
});

describe("tar reader", () => {
  const one = () => Buffer.from(writeTar([{ path: "a/b.txt", type: "file", data: Buffer.from("hello") }]));
  it("round-trips a path whose prefix is over 100 bytes", () => {
    const path = `${"d".repeat(60)}/${"e".repeat(60)}/file.txt`;
    const back = readTar(writeTar([{ path, type: "file", data: Buffer.from("hi") }]));
    expect(back).toHaveLength(1);
    expect(back[0]!.path).toBe(path);
    expect(back[0]!.data.toString()).toBe("hi");
  });
  it("accepts a well-formed archive and zero padding after the end marker", () => {
    expect(readTar(Buffer.concat([one(), Buffer.alloc(1024)]))).toHaveLength(1);
  });
  it("rejects a bad checksum", () => {
    const t = one();
    t[0] = t[0]! ^ 1;
    expect(() => readTar(t)).toThrow(/checksum/);
  });
  it("rejects truncation (header, data, end marker, one end block)", () => {
    const t = one();
    expect(() => readTar(t.subarray(0, 100))).toThrow(/truncated/);
    expect(() => readTar(t.subarray(0, 512 + 100))).toThrow(/truncated/);
    expect(() => readTar(t.subarray(0, t.length - 1024))).toThrow(/truncated/);
    expect(() => readTar(t.subarray(0, t.length - 512))).toThrow(/two zero end blocks/);
  });
  it("rejects non-zero data after the end marker", () => {
    expect(() => readTar(Buffer.concat([one(), Buffer.from("junk")]))).toThrow(/after the end-of-archive/);
  });
  it("rejects pax, GNU long-name, link and special types", () => {
    for (const flag of ["x", "g", "L", "K", "1", "2", "3", "4", "6"]) {
      const t = one();
      t[156] = flag.charCodeAt(0);
      fixHeaderSum(t);
      expect(() => readTar(t), flag).toThrow(/unsupported type/);
    }
  });
  it("rejects a huge declared size without allocating", () => {
    const t = one();
    t.write("77777777777\0", 124, "ascii");
    fixHeaderSum(t);
    expect(() => readTar(t)).toThrow(/truncated/);
    const u = one();
    u.write("99999999999\0", 124, "ascii"); // not octal
    fixHeaderSum(u);
    expect(() => readTar(u)).toThrow(/malformed size/);
  });
  it("validates octal fields strictly", () => {
    const t = one();
    t.write("12abc\0", 124, "ascii");
    fixHeaderSum(t);
    expect(() => readTar(t)).toThrow(/malformed size/);
    const c = one();
    c.write("0x1234\0 ", 148, "ascii");
    expect(() => readTar(c)).toThrow(/malformed checksum/);
  });
  it("rejects a directory entry with a size", () => {
    const t = Buffer.from(writeTar([{ path: "d", type: "dir", data: Buffer.alloc(0) }]));
    t.write("00000000005\0", 124, "ascii");
    fixHeaderSum(t);
    expect(() => readTar(t)).toThrow(/non-zero size/);
  });
  it("rejects a non-ustar header", () => {
    const t = one();
    t.write("xxxxx", 257, "ascii");
    fixHeaderSum(t);
    expect(() => readTar(t)).toThrow(/ustar/);
  });
});
