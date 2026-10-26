import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { contentHash, type KbRoots } from "../shared/index.js";
import { emitDelta } from "./emitDelta.js";

const WOLF = "w1";
let root: string;
let roots: KbRoots;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "emit-delta-"));
  roots = { kbBase: join(root, "kb"), opsRoot: join(root, "ops"), denLocal: join(root, "den", "kb") };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const input = (body: string, extra = {}) => ({ roots, wolf: WOLF, denTopicId: "t", change: "create" as const, domainHint: "wolfpack", summary: "s", body, ...extra });
const inbox = () => readdirSync(join(roots.opsRoot, "inbox", WOLF));
const emittedMap = () => JSON.parse(readFileSync(join(roots.denLocal, "emitted.json"), "utf-8"));
const emittedBody = () => join(roots.denLocal, "emitted-bodies", "t.md");

describe("emitDelta force", () => {
  it("an unchanged body is skipped without force", () => {
    expect(emitDelta(input("body"))).not.toBeNull();
    rmSync(join(roots.opsRoot, "inbox"), { recursive: true });
    expect(emitDelta(input("body"))).toBeNull();
    expect(existsSync(join(roots.opsRoot, "inbox", WOLF))).toBe(true);
    expect(inbox()).toEqual([]);
  });

  it("a forced resend re-writes the inbox file and still updates emitted.json and emitted-bodies", () => {
    emitDelta(input("body"));
    rmSync(join(roots.opsRoot, "inbox"), { recursive: true });
    // Damage both dedup stores: the forced emit must write them back.
    writeFileSync(join(roots.denLocal, "emitted.json"), JSON.stringify({ t: "stale", other: "kept" }));
    rmSync(join(roots.denLocal, "emitted-bodies"), { recursive: true });

    const c = emitDelta(input("body", { force: true }));

    expect(c).toMatchObject({ denTopicId: "t", contentHash: contentHash("body"), prevHash: "stale" });
    expect(inbox()).toHaveLength(1);
    expect(emittedMap()).toEqual({ t: contentHash("body"), other: "kept" });
    expect(readFileSync(emittedBody(), "utf-8")).toBe("body");
  });

  it("forcing a body equal to the recorded one re-sends it with prevHash set", () => {
    emitDelta(input("body"));
    rmSync(join(roots.opsRoot, "inbox"), { recursive: true });
    const c = emitDelta(input("body", { force: true }));
    expect(c?.prevHash).toBe(contentHash("body"));
    expect(inbox()).toHaveLength(1);
    expect(emittedMap()).toEqual({ t: contentHash("body") });
  });
});
