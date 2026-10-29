/** Seam 2: ledger-level tests for hubd work writes: byte compatibility with direct work-ops, concurrency, the writer lock. */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACTOR_HEADER } from "@wolfpack/protocol";
import { createWork, loadWorkState, moveWork, noteWork, stageWork, graduateWork, deleteWork, setCriteria } from "@wolfpack/kb/client";
import { createHubServer, type HubServer } from "./server.js";
import { spawnSync } from "node:child_process";
import { applyOps, assertSectionText, pidAlive, replaceSection, sweepStageDirs } from "./work-writes.js";
import { hubRoots } from "./layout.js";
import { FIXTURE_DOMAIN, seedFixture } from "./testing/fixture.js";

const KEY = "k";
const OP = { [ACTOR_HEADER]: JSON.stringify({ id: "1uk4", kind: "operator" }) };
const tmp: string[] = [];
const servers: HubServer[] = [];
const mk = () => {
  const d = mkdtempSync(join(tmpdir(), "hubd-writes-"));
  tmp.push(d);
  return d;
};
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
});
const start = async (dataDir: string) => {
  const h = await createHubServer({ dataDir, apiKey: KEY });
  servers.push(h);
  return h;
};
const req = (h: HubServer, method: string, path: string, body?: unknown) =>
  fetch(h.url + path, { method, headers: { "X-API-Key": KEY, "Content-Type": "application/json", ...OP }, body: body === undefined ? undefined : JSON.stringify(body) });
const ledger = (dir: string) => readFileSync(join(dir, "ledger", "work-events.jsonl"), "utf8");

/** Normalise the fields that legitimately differ between runs: every `at` timestamp, and the generated ids (work-<domain>-<random>) mapped to stable placeholders by first appearance. */
function normalise(text: string): string[] {
  const ids = new Map<string, string>();
  const idOf = (id: string) => (ids.has(id) ? ids.get(id)! : (ids.set(id, `<id${ids.size}>`), ids.get(id)!));
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => l.replace(/"at":"[^"]*"/g, '"at":"<at>"').replace(/work-[a-z0-9-]+-[a-z0-9]{4,}/gi, (m) => idOf(m)));
}

describe("ledger byte compatibility", () => {
  it("HTTP writes append the same bytes as direct work-ops on a copy (modulo timestamps and generated ids)", async () => {
    const src = mk();
    const seeded = seedFixture(src);
    const a = mk();
    const b = mk();
    cpSync(src, a, { recursive: true });
    cpSync(src, b, { recursive: true });
    const before = ledger(src);
    const [t1, t2] = seeded.tasks;
    const inbox = [...loadWorkState(hubRoots(src)).values()].find((w) => w.container)!.id as string;

    // A: through hubd HTTP
    const hub = await start(a);
    const created = (await (await req(hub, "POST", "/v1/work", { kind: "task", domain: FIXTURE_DOMAIN, title: "New task", assignee: "1uk4", partOf: seeded.feature.id, successCriteria: "ok" })).json()) as { id: string };
    expect((await req(hub, "PATCH", `/v1/work/${created.id}`, { stage: "in_build" })).status).toBe(200);
    expect((await req(hub, "PATCH", `/v1/work/${t1}`, { note: "a note" })).status).toBe(200);
    expect((await req(hub, "PATCH", `/v1/work/${t1}`, { moveTo: inbox })).status).toBe(200);
    expect((await req(hub, "PATCH", `/v1/work/${t2}`, { successCriteria: "changed" })).status).toBe(200);
    expect((await req(hub, "POST", `/v1/work/${t2}/graduate`)).status).toBe(200);
    expect((await req(hub, "DELETE", `/v1/work/${created.id}`)).status).toBe(200);

    // B: directly through work-ops, same sequence
    const rb = hubRoots(b);
    const c = createWork(rb, { kind: "task", domain: FIXTURE_DOMAIN, title: "New task", assignee: "1uk4", partOf: seeded.feature.id, successCriteria: "ok" });
    stageWork(rb, c.id, "in_build");
    noteWork(rb, t1, "a note");
    moveWork(rb, t1, inbox);
    setCriteria(rb, t2, "changed");
    graduateWork(rb, t2);
    deleteWork(rb, c.id);

    const la = ledger(a);
    const lb = ledger(b);
    expect(la.startsWith(before)).toBe(true); // pre-existing bytes untouched
    expect(lb.startsWith(before)).toBe(true);
    const appendedA = normalise(la.slice(before.length));
    const appendedB = normalise(lb.slice(before.length));
    expect(appendedA.length).toBeGreaterThan(5);
    expect(appendedA).toEqual(appendedB);
    // Every appended `at` has the same shape as the ones kb writes (and the pre-existing lines).
    for (const line of la.slice(before.length).split("\n").filter(Boolean)) expect((JSON.parse(line) as { at: string }).at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/);
    for (const line of la.slice(before.length).split("\n").filter(Boolean)) JSON.parse(line);
  });
});

describe("serialised concurrent writers", () => {
  it("N concurrent POST/PATCH all land; ledger lines are well-formed; folded state is consistent", async () => {
    const dir = mk();
    const seeded = seedFixture(dir);
    const hub = await start(dir);
    const N = 25;
    const created = await Promise.all(
      Array.from({ length: N }, (_, i) => req(hub, "POST", "/v1/work", { kind: "task", domain: FIXTURE_DOMAIN, title: `c${i}`, assignee: "1uk4", partOf: seeded.feature.id }).then((r) => r.json() as Promise<{ id: string }>)),
    );
    expect(new Set(created.map((c) => c.id)).size).toBe(N);
    const patches = await Promise.all(
      created.flatMap((c, i) => [req(hub, "PATCH", `/v1/work/${c.id}`, { note: `n${i}` }), req(hub, "PATCH", `/v1/work/${c.id}`, { title: `t${i}` })]),
    );
    expect(patches.every((r) => r.status === 200)).toBe(true);
    const lines = ledger(dir).split("\n").filter(Boolean);
    for (const l of lines) JSON.parse(l);
    const state = loadWorkState(hubRoots(dir));
    created.forEach((c, i) => expect(state.get(c.id as never)?.title).toBe(`t${i}`));
    expect(lines.filter((l) => l.includes('"work.noted"')).length).toBe(N);
  });

  it("the post-append hook sees every appended event in order", async () => {
    const dir = mk();
    seedFixture(dir);
    const hub = await start(dir);
    const seen: string[] = [];
    hub.onWorkAppended(({ actor, events }) => {
      expect(actor.id).toBe("1uk4");
      seen.push(...events.map((e) => e.type));
    });
    await req(hub, "POST", "/v1/work", { kind: "idea", domain: FIXTURE_DOMAIN, title: "hooked", assignee: "1uk4" });
    expect(seen[0]).toBe("work.created");
  });
});

describe("writer lock", () => {
  it("a second hubd on the same dataDir is refused, and the lock is released on close", async () => {
    const dir = mk();
    const first = await start(dir);
    await expect(createHubServer({ dataDir: dir, apiKey: KEY })).rejects.toThrow(/already has a writer/);
    await first.close();
    servers.pop();
    const again = await start(dir);
    expect((await fetch(again.url + `/v1/work?domain=${FIXTURE_DOMAIN}`, { headers: { "X-API-Key": KEY } })).status).toBe(200);
  });
});

describe("batch PATCH, sections, owner-only", () => {
  const WOLF = { [ACTOR_HEADER]: JSON.stringify({ id: "w1", kind: "wolf" }) };
  const patch = (h: HubServer, id: string, body: unknown, headers: Record<string, string> = OP) =>
    fetch(h.url + `/v1/work/${id}`, { method: "PATCH", headers: { "X-API-Key": KEY, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const codeOf = async (r: Response) => ((await r.json()) as { code: string }).code;

  it("applies a batch in order; a failing op appends nothing (ledger byte-identical)", async () => {
    const dir = mk();
    const seeded = seedFixture(dir);
    const t = seeded.tasks[0];
    const hub = await start(dir);
    const ok = await patch(hub, t, { ops: [{ note: "one" }, { title: "Renamed" }] });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { item: { title: string } }).item.title).toBe("Renamed");
    const before = ledger(dir);
    expect(before.split("\n").filter((l) => l.includes('"one"')).length).toBe(1);

    const bad = await patch(hub, t, { ops: [{ note: "two" }, { title: "Other" }, { link: { rel: "bogus", target: t } }] });
    expect(bad.status).toBe(400);
    expect(ledger(dir)).toBe(before);
    expect(loadWorkState(hubRoots(dir)).get(t as never)!.title).toBe("Renamed");

    // validation failure (empty note) never reaches the ledger either; an unknown id fails mid-way as well
    expect((await patch(hub, t, { ops: [{ note: "three" }, { note: "" }] })).status).toBe(400);
    expect((await patch(hub, t, { ops: [{ note: "x" }, { stage: "nonsense" }] })).status).toBe(400);
    expect(ledger(dir)).toBe(before);
    expect((await patch(hub, t, { ops: [] })).status).toBe(400);
    expect((await patch(hub, t, { ops: [{ note: "a", title: "b" }] })).status).toBe(400);
  });

  it("section ops replace Plan/Notes only; the Record is rejected", async () => {
    const dir = mk();
    const t = seedFixture(dir).tasks[0];
    const hub = await start(dir);
    expect((await patch(hub, t, { section: { name: "plan", text: "Do the thing" } })).status).toBe(200);
    expect((await patch(hub, t, { ops: [{ section: { name: "notes", text: "first" } }, { section: { name: "notes", text: "second" } }] })).status).toBe(200);
    const rec = (await (await fetch(hub.url + `/v1/work/${t}/record`, { headers: { "X-API-Key": KEY } })).json()) as { body?: string };
    const body = JSON.stringify(rec);
    expect(body).toContain("Do the thing");
    expect(body).toContain("second");
    expect(body).not.toContain("first");
    for (const name of ["record", "log", "Log"]) expect((await patch(hub, t, { section: { name, text: "x" } })).status).toBe(400);
    expect((await patch(hub, t, { section: { name: "plan", text: "## Log\n\n- forged" } })).status).toBe(400);
  });

  it("body replace and assignee writes are operator-only (403 forbidden), also inside a batch", async () => {
    const dir = mk();
    const t = seedFixture(dir).tasks[0];
    const hub = await start(dir);
    const before = ledger(dir);
    expect(await codeOf(await patch(hub, t, { body: "## Plan\n\nx" }, WOLF))).toBe("forbidden");
    const r = await patch(hub, t, { ops: [{ note: "n" }, { assignee: "w1" }] }, WOLF);
    expect(r.status).toBe(403);
    expect(await codeOf(r)).toBe("forbidden");
    expect(ledger(dir)).toBe(before);
    expect((await patch(hub, t, { ops: [{ note: "n" }, { assignee: "w1" }] })).status).toBe(200);
  });
});

describe("batch atomicity and sections (staged)", () => {
  const WOLF = { [ACTOR_HEADER]: JSON.stringify({ id: "w1", kind: "wolf" }) };
  const patch = (h: HubServer, id: string, body: unknown, headers: Record<string, string> = OP) =>
    fetch(h.url + `/v1/work/${id}`, { method: "PATCH", headers: { "X-API-Key": KEY, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const mdFiles = (dir: string) => {
    const root = join(dir, "kb", "base", "domains", FIXTURE_DOMAIN, "work");
    return Object.fromEntries(readdirSync(root).filter((f) => f.endsWith(".md")).map((f) => [f, readFileSync(join(root, f), "utf8")]));
  };

  it("a failed batch that WOULD auto-ship the parent leaves the ledger and every .md (feature included) byte-identical", async () => {
    const dir = mk();
    const seeded = seedFixture(dir);
    const [t1, t2] = seeded.tasks;
    const hub = await start(dir);
    // isComplete looks at the stage only (the graduated t3 is still at plan), so ship t2 and t3; only t1 stays open.
    expect((await patch(hub, t2, { stage: "shipped" })).status).toBe(200);
    expect((await patch(hub, seeded.graduated, { stage: "shipped" })).status).toBe(200);
    expect(mdFiles(dir)[`${seeded.feature.id}.md`]).not.toMatch(/^stage: shipped$/m); // t3 is graduated; only t1 stays open
    const ledgerBefore = ledger(dir);
    const mdBefore = mdFiles(dir);
    const r = await patch(hub, t1, { ops: [{ stage: "shipped" }, { note: "x" }, { link: { rel: "bogus", target: "nope" } }] });
    expect(r.status).toBe(400);
    expect(ledger(dir)).toBe(ledgerBefore);
    expect(mdFiles(dir)).toEqual(mdBefore);
    expect(mdBefore[`${seeded.feature.id}.md`]).not.toMatch(/^stage: shipped$/m);
  });

  it("the same batch without the failing op auto-ships the parent: ledger gets the feature's events, feature .md is re-rendered", async () => {
    const dir = mk();
    const seeded = seedFixture(dir);
    const [t1, t2] = seeded.tasks;
    const hub = await start(dir);
    // isComplete looks at the stage only (the graduated t3 is still at plan), so ship t2 and t3; only t1 stays open.
    expect((await patch(hub, t2, { stage: "shipped" })).status).toBe(200);
    expect((await patch(hub, seeded.graduated, { stage: "shipped" })).status).toBe(200);
    expect(mdFiles(dir)[`${seeded.feature.id}.md`]).not.toMatch(/^stage: shipped$/m);
    const before = ledger(dir);
    const featBefore = mdFiles(dir)[`${seeded.feature.id}.md`];
    expect(featBefore).not.toMatch(/^stage: shipped$/m);
    expect((await patch(hub, t1, { ops: [{ stage: "shipped" }, { note: "x" }] })).status).toBe(200);
    const added = ledger(dir).slice(before.length).split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; id: string; to?: string });
    expect(added.some((e) => e.type === "work.staged" && e.id === seeded.feature.id && e.to === "shipped")).toBe(true);
    expect(added.some((e) => e.type === "work.noted" && e.id === seeded.feature.id)).toBe(true);
    const featAfter = mdFiles(dir)[`${seeded.feature.id}.md`];
    expect(featAfter).toMatch(/^stage: shipped$/m);
    expect(featAfter).toContain("Decided things."); // body preserved
  });

  it("a successful batch appends once and renders touched .md files; the scratch dir is gone", async () => {
    const dir = mk();
    const t = seedFixture(dir).tasks[0];
    const hub = await start(dir);
    const r = await patch(hub, t, { ops: [{ note: "n1" }, { note: "n2" }] });
    expect(r.status).toBe(200);
    expect((await patch(hub, t, { section: { name: "plan", text: "P" } })).status).toBe(200);
    expect(ledger(dir).split("\n").filter((l) => l.includes('"n1"') || l.includes('"n2"')).length).toBe(2);
    expect(mdFiles(dir)[`${t}.md`]).toContain("## Plan\n\nP");
  });

  it("[section, failing op] leaves the body untouched; 51 ops are rejected", async () => {
    const dir = mk();
    const t = seedFixture(dir).tasks[0];
    const hub = await start(dir);
    const before = mdFiles(dir);
    const r = await patch(hub, t, { ops: [{ section: { name: "plan", text: "changed" } }, { stage: "nonsense" }] });
    expect(r.status).toBe(400);
    expect(mdFiles(dir)).toEqual(before);
    const many = await patch(hub, t, { ops: Array.from({ length: 51 }, () => ({ note: "x" })) });
    expect(many.status).toBe(400);
  });

  it("failure injection: a failure after staging leaves nothing; a render failure after the append still succeeds (committed)", () => {
    const dir = mk();
    const t = seedFixture(dir).tasks[0];
    const roots = hubRoots(dir);
    const ops = [{ op: "note", text: "a" }, { op: "note", text: "b" }] as const;
    const before = ledger(dir);
    const mdBefore = mdFiles(dir);
    const scratchRoot = mk();
    expect(() => applyOps(roots, t, [...ops], { afterStaged: () => { throw new Error("boom"); }, tmpRoot: scratchRoot })).toThrow("boom");
    expect(readdirSync(scratchRoot)).toEqual([]);
    expect(ledger(dir)).toBe(before);
    expect(mdFiles(dir)).toEqual(mdBefore);
    // A render failure AFTER the single append: the batch is committed, the call succeeds, the .md is merely stale.
    const item = applyOps(roots, t, [...ops], { afterAppend: () => { throw new Error("disk"); }, tmpRoot: scratchRoot });
    expect(item.id).toBe(t);
    const added = ledger(dir).slice(before.length).split("\n").filter(Boolean);
    expect(added.length).toBe(2);
    expect(mdFiles(dir)).toEqual(mdBefore); // stale, not partial
    expect(readdirSync(scratchRoot)).toEqual([]);
    // the next write to the item repairs the .md
    applyOps(roots, t, [{ op: "note", text: "c" }]);
    expect(mdFiles(dir)[`${t}.md`]).toContain("— b");
  });

  it("a malformed single-op body is invalid_request with a real message (not a bare invalid_union)", async () => {
    const dir = mk();
    const t = seedFixture(dir).tasks[0];
    const hub = await start(dir);
    const r = await patch(hub, t, { stage: 5 });
    expect(r.status).toBe(400);
    const e = (await r.json()) as { code: string; message: string };
    expect(e.code).toBe("invalid_request");
    expect(e.message).toMatch(/stage/);
    expect(e.message).not.toMatch(/invalid_union/);
    expect((await patch(hub, t, { ops: "x" })).status).toBe(400);
    expect((await patch(hub, t, { ops: [{ bogus: 1 }] })).status).toBe(400);
  });

  it("a non-operator batch with assignee is 403 forbidden", async () => {
    const dir = mk();
    const t = seedFixture(dir).tasks[0];
    const hub = await start(dir);
    const r = await patch(hub, t, { ops: [{ note: "n" }, { assignee: "w1" }] }, WOLF);
    expect(r.status).toBe(403);
  });
});

describe("section text and replaceSection", () => {
  const bad = (t: string) => expect(() => assertSectionText(t)).toThrow();
  it("rejects headings outside fences: indented, bare, setext, quoted, list-nested", () => {
    for (const t of ["## Log", "   ## Log", "##", "# Title", "#\tx", "Log\n---", "Log\n===", "text\n  ---  ", "> ## Log", "- ## Log", "a\r\n## b"]) bad(t);
    bad("```\nopen but never closed\n## x");
  });
  it("allows headings inside fences, thematic breaks after a blank line, deep indent and plain text", () => {
    for (const t of ["```\n## Log\n```", "~~~md\n# h\n~~~", "para\n\n---\n\nmore", "    ## code", "####### seven", "#hashtag", "a ## b"]) expect(() => assertSectionText(t)).not.toThrow();
  });
  it("replaces a section up to the next heading, ignoring fenced '##'", () => {
    const body = "## Plan\n\n```\n## not a heading\n```\nold\n\n## Notes\n\nkeep\n";
    expect(replaceSection(body, "plan", "new")).toBe("## Plan\n\nnew\n\n## Notes\n\nkeep\n");
    expect(replaceSection("## Plan\r\n\r\nold\r\n\r\n## Notes\r\n\r\nk\r\n", "notes", "z")).toBe("## Plan\n\nold\n\n## Notes\n\nz\n");
  });
  it("a fenced '## Plan' is not the heading; a setext heading ends the section", () => {
    expect(replaceSection("```\n## Plan\n```\n\n## Notes\n\nn\n", "plan", "P")).toBe("```\n## Plan\n```\n\n## Plan\n\nP\n\n## Notes\n\nn\n");
    expect(replaceSection("## Plan\n\nold\n\nOther\n---\n\nrest\n", "plan", "P")).toBe("## Plan\n\nP\n\nOther\n---\n\nrest\n");
  });
  it("a missing Plan goes before Notes; a missing Notes is appended; empty text leaves a bare heading", () => {
    expect(replaceSection("## Notes\n\nn\n", "plan", "P")).toBe("## Plan\n\nP\n\n## Notes\n\nn\n");
    expect(replaceSection("## Plan\n\np\n", "notes", "N")).toBe("## Plan\n\np\n\n## Notes\n\nN\n");
    expect(replaceSection("## Plan\n\np\n\n## Notes\n\nn\n", "plan", "")).toBe("## Plan\n\n## Notes\n\nn\n");
  });
  it("duplicate headings are rejected", () => {
    expect(() => replaceSection("## Plan\n\na\n\n## Plan\n\nb\n", "plan", "x")).toThrow(/more than one/);
  });
});

describe("mixed batches, orphan sweep, setext and fences", () => {
  const patch = (h: HubServer, id: string, body: unknown) =>
    fetch(h.url + `/v1/work/${id}`, { method: "PATCH", headers: { "X-API-Key": KEY, "Content-Type": "application/json", ...OP }, body: JSON.stringify(body) });

  it("section/body ops can't be mixed with ledger ops; a content-only batch is one .md write with no ledger change", async () => {
    const dir = mk();
    const t = seedFixture(dir).tasks[0];
    const hub = await start(dir);
    const before = ledger(dir);
    for (const ops of [[{ note: "n" }, { section: { name: "plan", text: "p" } }], [{ body: "## Plan\n\nx" }, { note: "n" }]]) {
      const r = await patch(hub, t, { ops });
      expect(r.status).toBe(400);
      const e = (await r.json()) as { code: string; message: string };
      expect(e.code).toBe("invalid_request");
      expect(e.message).toMatch(/send them separately/);
    }
    expect(ledger(dir)).toBe(before);
    const ok = await patch(hub, t, { ops: [{ section: { name: "plan", text: "P" } }, { section: { name: "notes", text: "N" } }] });
    expect(ok.status).toBe(200);
    expect(ledger(dir)).toBe(before);
    const md = readFileSync(join(dir, "kb", "base", "domains", FIXTURE_DOMAIN, "work", `${t}.md`), "utf8");
    expect(md).toContain("## Plan\n\nP");
    expect(md).toContain("## Notes\n\nN");
    // a failing section in a content batch writes nothing
    const md0 = md;
    const bad = await patch(hub, t, { ops: [{ section: { name: "plan", text: "Z" } }, { section: { name: "log", text: "x" } }] });
    expect(bad.status).toBe(400);
    expect(readFileSync(join(dir, "kb", "base", "domains", FIXTURE_DOMAIN, "work", `${t}.md`), "utf8")).toBe(md0);
  });

  it("sweepStageDirs: removes pid<=0 and dead-pid stage dirs only; live pid, other names and bad names stay", () => {
    const root = mk();
    const child = spawnSync(process.execPath, ["-e", "0"]); // exits before we look: its pid is dead
    const deadPid = child.pid;
    expect(pidAlive(deadPid)).toBe(false);
    const names = {
      dead: `hubd-stage-${deadPid}-abc123`,
      zero: "hubd-stage-0-abc123",
      live: `hubd-stage-${process.pid}-abc123`,
      other: "something-else",
      bad: "hubd-stage-notapid",
    };
    for (const d of Object.values(names)) mkdirSync(join(root, d));
    expect(sweepStageDirs(root)).toBe(2);
    expect(readdirSync(root).sort()).toEqual([names.live, names.other, names.bad].sort());
    // injected liveness
    expect(sweepStageDirs(root, () => false)).toBe(1);
    expect(readdirSync(root).sort()).toEqual([names.other, names.bad].sort());
  });

  it("batch scratch dirs live under <dataDir>/tmp and are gone afterwards; a fold failure after the append still succeeds", () => {
    const dir = mk();
    const t = seedFixture(dir).tasks[0];
    const roots = hubRoots(dir);
    const item = applyOps(roots, t, [{ op: "note", text: "a" }, { op: "note", text: "b" }], { beforeResult: () => { throw new Error("fold"); } });
    expect(item.id).toBe(t);
    expect(ledger(dir).split("\n").filter((l) => l.includes('"a"') || l.includes('"b"')).length).toBe(2);
    expect(readdirSync(join(dir, "tmp"))).toEqual([]);
  });

  it("setext underline only counts under a plain paragraph line; closing-hash ATX is the heading", () => {
    // `## Plan\n---` : the --- is a thematic break (previous line is ATX), not a second heading
    expect(replaceSection("## Plan\n---\nold\n\n## Notes\n\nn\n", "plan", "P")).toBe("## Plan\n\nP\n\n## Notes\n\nn\n");
    expect(() => assertSectionText("## x\n---")).toThrow();
    for (const t of ["- item\n---", "> quote\n---", "| a | b |\n---", "---\n---"]) expect(() => assertSectionText(t)).not.toThrow();
    expect(() => assertSectionText("para\n---")).toThrow();
    expect(replaceSection("## Plan ##\n\nold\n\n## Notes\n\nn\n", "plan", "P")).toBe("## Plan\n\nP\n\n## Notes\n\nn\n");
    expect(() => replaceSection("## Plan\n\na\n\n## Plan ##\n\nb\n", "plan", "x")).toThrow(/more than one/);
  });

  it("fences: a longer closing fence closes, a shorter or other-char one does not, a backtick in a backtick info string is no fence", () => {
    expect(() => assertSectionText("```\n## x\n`````")).not.toThrow(); // longer closer
    expect(() => assertSectionText("````\n## x\n```")).toThrow(); // shorter closer: still open
    expect(() => assertSectionText("```\n## x\n~~~")).toThrow(); // other char: still open
    expect(() => assertSectionText("~~~\n## x\n~~~")).not.toThrow();
    expect(() => assertSectionText("``` a`b\n## x")).toThrow(); // not a fence, so the ## is a heading
    expect(() => assertSectionText("~~~ a`b\n## x\n~~~")).not.toThrow(); // backtick is fine in a ~~~ info string
  });
});
