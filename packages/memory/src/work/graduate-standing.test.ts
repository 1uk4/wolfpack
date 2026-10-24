/**
 * Graduation of a feature of a STANDING initiative: its own pinned, verbatim
 * entry grouped under the initiative's. Ordinary features are unchanged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "@wolfpack/engine";
import type { WorkItem } from "@wolfpack/kb/client";
import type { KbRoots } from "@wolfpack/kb/shared";
import { confirmGraduation, deliveredFor, FEATURE_ENTRY_CAP, isStanding, previewGraduation, renderFeatureEntry, type GraduationClient } from "./graduate.js";
import { scanSecrets } from "./secrets.js";

let n = 0;
const w = (kind: string, title: string, partOf: string | null, extra: Record<string, unknown> = {}) =>
  ({
    id: `work-wp-${kind.slice(0, 3)}${String(++n).padStart(4, "0")}`.slice(0, 15),
    kind, title, partOf, domain: "wp", stage: "shipped", successCriteria: null, created: "2026-10-14",
    log: [], dependsOn: [], graduated: null, container: false, ...extra,
  }) as unknown as WorkItem;

const DOC = [
  "# Period one", "",
  "## Plan", "", "Do the thing. See work-wp-zzz9999.", "",
  "## Outcomes", "",
  "<!-- rollup:children -->", "<!-- rollup:item id=t1 when=2026-10-15 -->", "| item | n |", "|------|---|", "| a | 3 |", "- Task done in commit abc1234, deployed", "<!-- /rollup:item -->", "<!-- /rollup:children -->", "",
  "## Totals", "", '<!-- rollup:totals keys="N" -->', "- N: **3**", "<!-- /rollup:totals -->", "",
  "## Record", "", "### Decisions", "", "- Chose X — why: Y.", "",
].join("\n");

function fakeClient(items: WorkItem[], bodies: Record<string, string>) {
  const calls: string[] = [];
  const client: GraduationClient = {
    query: async () => items,
    getWithBody: async (id) => ({ item: items.find((i) => i.id === id)!, body: bodies[id] ?? null }),
    graduate: async (id) => { calls.push(`graduate ${id}`); return items.find((i) => i.id === id)!; },
    stage: async (id, to) => { calls.push(`stage ${id} ${to}`); return items.find((i) => i.id === id)!; },
    note: async (id, text) => { calls.push(`note ${id} ${text}`); return items.find((i) => i.id === id)!; },
  };
  return { client, calls };
}

function engineOf(...answers: unknown[]) {
  let i = 0;
  const call = vi.fn(async (_s: string, schema: { parse: (v: unknown) => unknown }) => schema.parse(answers[Math.min(i++, answers.length - 1)]));
  return { engine: { call, usage: { summarize: () => ({}) } } as unknown as Engine, call };
}

const featureOut = { slug: "feature", feature: true, title: "whatever the model says", summary: "This period did the thing; N was 3.", body: "Short." };
const initOut = { slug: "initiative", initiative: true, title: "Area", summary: "The area is live.", body: "## Scope\n\nThings.\n\n## History\n\n- 2026-10-22: added a period" };
const subjectOut = (workId: string) => ({ slug: "rule", title: "A lasting rule", summary: "How X works.", body: `## Rule\n\nAlways.\n\n## History\n\n- 2026-10-22: chose X (${workId})` });

describe("graduating a feature of a standing initiative", () => {
  let dir: string;
  let roots: KbRoots;
  let init: WorkItem, f: WorkItem, t1: WorkItem;
  const inbox = () => join(roots.opsRoot, "inbox", "owner");
  const fileOf = (topic: string) => readFileSync(join(inbox(), readdirSync(inbox()).find((x) => new RegExp(`^${topic.replace(/~/g, "_")}-[0-9a-f]+\\.md$`).test(x) || x.startsWith(`${topic}-`))!), "utf8");

  beforeEach(() => {
    n = 0;
    dir = mkdtempSync(join(tmpdir(), "grad-standing-"));
    roots = { kbBase: join(dir, "kb"), opsRoot: join(dir, "ops"), denLocal: join(dir, "den") };
    init = w("initiative", "Area", null, { standing: true, successCriteria: "Keep going", stage: "in_build" });
    f = w("feature", "Period one", init.id, { created: "2026-10-14" });
    t1 = w("task", "Do a", f.id);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("isStanding: only a feature whose initiative is standing", () => {
    const plain = w("initiative", "Plain", null);
    const g = w("feature", "G", plain.id);
    expect(isStanding(f, [init, f])).toBe(true);
    expect(isStanding(g, [plain, g])).toBe(false);
    expect(isStanding(init, [init])).toBe(false);
    expect(isStanding(t1, [init, f, t1])).toBe(false);
  });

  it("preview: initiative, then the feature entry (the item's own document, model's summary), then subjects", async () => {
    const { client } = fakeClient([init, f, t1], { [f.id]: DOC });
    const { engine, call } = engineOf({ contributions: [subjectOut(f.id as string), featureOut, initOut] });
    const p = await previewGraduation({ client, engine, id: f.id as string, today: "2026-10-22" });
    expect((call.mock.calls[0] as any)[2].system).toContain("STANDING FEATURE");
    expect((call.mock.calls[0] as any)[2].prompt).toContain("STANDING FEATURE: this feature is kept as its own entry");
    expect(p.contributions.map((c) => [c.id, !!c.initiative, !!c.feature])).toEqual([
      [init.id, true, false],
      [f.id, false, true],
      [`${f.id}~rule`, false, false],
    ]);
    const feat = p.contributions[1];
    expect(feat.title).toBe("Period one"); // the item's title, not the model's
    expect(feat.summary).toBe("This period did the thing; N was 3.");
    expect(feat.body.startsWith("# Period one\n\n## Plan")).toBe(true);
    // as authored: ids, hashes, deploy status, tables and Totals are kept; only the markers go
    expect(feat.body).toContain("work-wp-zzz9999");
    expect(feat.body).toContain("commit abc1234, deployed");
    expect(feat.body).toContain("| item | n |\n|------|---|\n| a | 3 |");
    expect(feat.body).toContain("- N: **3**");
    expect(feat.body).toContain("## Record");
    expect(feat.body).not.toContain("rollup:");
    expect(feat.body).not.toContain("## Tasks"); // the rollup zone carries the tasks
    expect(p.warnings.filter((x) => /redacted|cut/.test(x))).toEqual([]);
  });

  it("confirm emits the initiative, the feature (anchored, verbatim, grouped under the initiative, dated), then the subjects", async () => {
    const { client } = fakeClient([init, f, t1], { [f.id]: DOC });
    const { engine } = engineOf({ contributions: [subjectOut(f.id as string), featureOut, initOut] });
    const p = await previewGraduation({ client, engine, id: f.id as string, today: "2026-10-22" });
    const done = await confirmGraduation({ client, roots, wolf: "owner", preview: p, ship: async () => {} });
    expect(done.sent).toEqual([init.id, f.id, `${f.id}~rule`]);
    const feature = fileOf(f.id as string);
    expect(feature).toMatch(new RegExp(`^anchor: ${f.id}$`, "m"));
    expect(feature).toMatch(/^verbatim: true$/m);
    expect(feature).toMatch(new RegExp(`^group: ${init.id}$`, "m"));
    expect(feature).toMatch(/^group_date: 2026-10-14$/m);
    expect(feature).toMatch(/^change: merge$/m);
    const initiative = fileOf(init.id as string);
    expect(initiative).toMatch(new RegExp(`^anchor: ${init.id}$`, "m"));
    expect(initiative).not.toMatch(/^verbatim:|^group:/m);
    const subject = fileOf(`${f.id}~rule`);
    expect(subject).not.toMatch(/^anchor:|^verbatim:|^group:/m);
  });

  it("without a feature contribution from the model, the entry still exists (summary from the item)", async () => {
    const { client } = fakeClient([init, f, t1], { [f.id]: DOC });
    const { engine } = engineOf({ contributions: [initOut] });
    const p = await previewGraduation({ client, engine, id: f.id as string, today: "2026-10-22" });
    expect(p.contributions.map((c) => c.id)).toEqual([init.id, f.id]);
    expect(p.contributions[1]).toMatchObject({ feature: true, title: "Period one", summary: "Period one" });
    expect(p.warnings.some((x) => /no summary of the feature/.test(x))).toBe(true);
  });

  it("redacts credentials from the entry and says so in the preview", async () => {
    const secretDoc = `${DOC}\n## Notes\n\napi_key = sk-abcdefghijklmnopqrstuvwx1234\nBearer abcdefghijklmnopqrstuvwxyz0123456789\n`;
    const { client } = fakeClient([init, f, t1], { [f.id]: secretDoc });
    const { engine } = engineOf({ contributions: [featureOut, initOut] });
    const p = await previewGraduation({ client, engine, id: f.id as string, today: "2026-10-22" });
    const feat = p.contributions.find((c) => c.feature)!;
    expect(feat.body).not.toContain("sk-abcdefghijklmnopqrstuvwx1234");
    expect(feat.body).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(feat.body).toContain("[REDACTED:");
    expect(p.warnings.some((x) => /redacted .* from the feature entry/.test(x))).toBe(true);
  });

  it("deliveredFor lists a standing initiative's features by creation date", () => {
    const late = w("feature", "Late", init.id, { created: "2026-10-21", graduated: "2026-10-22" });
    const early = w("feature", "Early", init.id, { created: "2026-10-07", graduated: "2026-10-08" });
    expect(deliveredFor(init, f, [init, late, early, f]).map((b) => b.title)).toEqual(["Early", "Period one", "Late"]);
    const plain = w("initiative", "Plain", null);
    const a = w("feature", "A-late", plain.id, { created: "2026-10-21", graduated: "x" });
    const b = w("feature", "B-early", plain.id, { created: "2026-10-07", graduated: "x" });
    expect(deliveredFor(plain, a, [plain, a, b]).map((x) => x.title)).toEqual(["A-late", "B-early"]); // order unchanged
  });
});

describe("an ordinary feature graduates as before", () => {
  let dir: string;
  let roots: KbRoots;
  beforeEach(() => {
    n = 0;
    dir = mkdtempSync(join(tmpdir(), "grad-ordinary-"));
    roots = { kbBase: join(dir, "kb"), opsRoot: join(dir, "ops"), denLocal: join(dir, "den") };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("same contributions, same order, no feature/verbatim/group flags, no standing prompt", async () => {
    const init = w("initiative", "Dockerize", null, { stage: "in_build" });
    const f = w("feature", "Compose", init.id, { stage: "in_build" });
    const t = w("task", "T", f.id);
    const { client } = fakeClient([init, f, t], { [f.id]: "# F\n\n## Plan\n\nx\n" });
    const main = { slug: "compose", title: "Compose stack", summary: "Runs.", body: `## How\n\nOne file.\n\n## History\n\n- 2026-10-22: moved (${f.id})` };
    const { engine, call } = engineOf({ contributions: [main, { ...initOut, title: "Dockerize" }] });
    const p = await previewGraduation({ client, engine, id: f.id as string, today: "2026-10-22" });
    expect((call.mock.calls[0] as any)[2].system).not.toContain("STANDING FEATURE");
    expect(p.contributions.map((c) => [c.id, !!c.initiative, c.feature])).toEqual([[f.id, false, undefined], [init.id, true, undefined]]);
    const done = await confirmGraduation({ client, roots, wolf: "owner", preview: p, ship: async () => {} });
    expect(done.sent).toEqual([f.id, init.id]);
    const dirFiles = join(roots.opsRoot, "inbox", "owner");
    const all = readdirSync(dirFiles).map((x) => readFileSync(join(dirFiles, x), "utf8"));
    expect(all.some((t) => /^verbatim:|^group:|^group_date:/m.test(t))).toBe(false);
    expect(all.filter((t) => /^anchor:/m.test(t))).toHaveLength(1); // only the initiative's
    expect(existsSync(dirFiles)).toBe(true);
  });
});

describe("renderFeatureEntry", () => {
  const item = w("feature", "Period one", null);
  const tasks = [w("task", "Do a", item.id, { stage: "shipped" }), w("task", "Do b", item.id, { stage: "in_build" })];

  it("strips the markers and the title, keeps everything else; no Tasks list when a rollup zone carries them", () => {
    const r = renderFeatureEntry(item, tasks, DOC);
    expect(r.truncated).toBe(false);
    expect(r.text.startsWith("## Plan")).toBe(true);
    expect(r.text).not.toMatch(/<!--/);
    expect(r.text).toContain("| a | 3 |");
    expect(r.text).toContain("commit abc1234");
    expect(r.text).toContain("work-wp-zzz9999");
    expect(r.text).not.toContain("## Tasks"); // DOC has a rollup zone
  });

  it("appends a Tasks list (title and stage) when there is no rollup zone", () => {
    const r = renderFeatureEntry(item, tasks, "# Period one\n\n## Plan\n\nx\n");
    expect(r.text).toBe("## Plan\n\nx\n\n## Tasks\n\n- Do a (shipped)\n- Do b (in_build)");
  });

  it("an empty document still has a body", () => {
    expect(renderFeatureEntry(item, [], "").text).toBe("Period one");
  });

  it("caps the body and says it was cut", () => {
    const r = renderFeatureEntry(item, [], `# T\n\n${"x".repeat(FEATURE_ENTRY_CAP + 500)}`);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThan(FEATURE_ENTRY_CAP + 50);
    expect(r.text.endsWith("…(truncated)")).toBe(true);
  });
});

describe("scanSecrets", () => {
  it.each([
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----", "private key"],
    ["token sk-ant-api03-abcdefghijklmnopqrstuvwxyz", "token"],
    ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "token"],
    ["AKIAABCDEFGHIJKLMNOP", "token"],
    ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345", "bearer token"],
    ["postgres://admin:hunter2pass@db.local/x", "url credentials"],
    ['password = "s3cretValue99"', "credential assignment"],
    ["DB_PASSWORD: Zx81!kqwe", "credential assignment"],
  ])("redacts %#", (input, kind) => {
    const r = scanSecrets(input);
    expect(r.findings.map((f) => f.kind)).toContain(kind);
    expect(r.text).toContain("[REDACTED:");
  });

  it.each([
    "The token budget is large and the password policy is strict.",
    "api_key: <your key here>",
    "password: required",
    "token: ${TOKEN}",
    "secret = https://example.com/docs",
    "Totals: 34,843 lb across 44 sets, commit abc1234 deployed to work-wp-zzz9999",
  ])("leaves ordinary text alone: %s", (input) => {
    const r = scanSecrets(input);
    expect(r.findings).toEqual([]);
    expect(r.text).toBe(input);
  });
});
