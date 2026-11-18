import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contentHash } from "@wolfpack/kb/shared";
import { reconcileAbsorbed } from "./absorbed.js";
import { readPromoteState } from "./promote-state.js";
import { writeTopic } from "./session/memory.js";

function setup() {
  const den = mkdtempSync(join(tmpdir(), "absorbed-"));
  return { den, root: join(den, ".memory", "sessions", "durable") };
}
const topic = (root: string, id: string, body: string, updated = "2026-10-10 10:00") =>
  writeTopic(root, { id, title: id, summary: "s", updated, body, sources: ["legacy"] });
function archive(den: string, id: string, absorbedInto: string, absorbedAt: string) {
  const dir = join(den, "memory", "archive");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), `---\nid: ${id}\ntitle: ${id}\nsummary: s\nupdated: 2026-10-01 10:00\nabsorbed_into: ${absorbedInto}\nabsorbed_at: ${absorbedAt}\n---\n\nold body\n`);
}
function distillRecord(den: string, id: string, body: string, target: string) {
  const dir = join(den, "kb", "distill");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ rawHash: contentHash(body), rawBody: body, at: "2026-10-12T00:00:00.000Z", slugs: [], outputs: [{ id: "x", slug: "x", title: "t", summary: "s", body: "b", target }] }));
}

describe("reconcileAbsorbed", () => {
  it("confirms a topic whose current body the KB already absorbed, and leaves the changed or unrecorded ones to promote", () => {
    const { den, root } = setup();
    topic(root, "by-distill", "same body");
    distillRecord(den, "by-distill", "same body", "kb-wolfpack-AAAAAAA");
    topic(root, "by-archive", "b", "2026-10-10 10:00");
    archive(den, "by-archive", "kb-wolfpack-BBBBBBB", "2026-10-11 09:00");
    topic(root, "updated-since", "b", "2026-10-12 10:00");
    archive(den, "updated-since", "kb-wolfpack-CCCCCCC", "2026-10-11 09:00");
    topic(root, "changed-body", "new body");
    distillRecord(den, "changed-body", "old body", "kb-wolfpack-DDDDDDD");
    topic(root, "no-record", "b");

    const r = reconcileAbsorbed({ den, root });

    expect(r.confirmed.sort()).toEqual(["by-archive", "by-distill"]);
    const st = readPromoteState(den).topics;
    expect(st["by-distill"].receipt).toEqual({ outcome: "merge", entryIds: ["kb-wolfpack-AAAAAAA"] });
    expect(st["by-archive"].receipt).toEqual({ outcome: "merge", entryIds: ["kb-wolfpack-BBBBBBB"] });
    expect(st["updated-since"]).toBeUndefined();
    expect(st["changed-body"]).toBeUndefined();
    expect(st["no-record"]).toBeUndefined();
  });
});
