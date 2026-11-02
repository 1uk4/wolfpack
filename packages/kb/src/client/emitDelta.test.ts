import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { contentHash, type KbRoots } from "../shared/index.js";
import { emitDelta } from "./emitDelta.js";
import { parseContribution } from "../librarian/intake.js";

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

describe("emitDelta canonical body", () => {
  for (const body of ["b\n", "b\n\n", "  b  ", "\n b\n"]) {
    it(`hash, file and parsed body agree for ${JSON.stringify(body)}`, () => {
      const c = emitDelta(input(body))!;
      expect(c.contentHash).toBe(contentHash("b"));
      const file = join(roots.opsRoot, "inbox", WOLF, inbox()[0]!);
      const parsed = parseContribution(file, WOLF);
      expect(parsed.contentHash).toBe(contentHash(parsed.body.slice("s\n\n".length)));
      expect(readFileSync(emittedBody(), "utf-8")).toBe("b");
      // the same body with other whitespace is an unchanged re-promote, not a new emit
      expect(emitDelta(input("b\n"))).toBeNull();
    });
  }
});

describe("emitDelta allowedDomains (domain_hint guard)", () => {
  it("writes a hint inside the wolf's subscribed domains", () => {
    expect(emitDelta(input("a", { domainHint: "personal", allowedDomains: ["personal"] }))).toMatchObject({ domainHint: "personal" });
    expect(inbox()).toHaveLength(1);
  });

  it("refuses a foreign hint: nothing written, nothing recorded as emitted", () => {
    expect(() => emitDelta(input("b", { domainHint: "wolfpack", allowedDomains: ["personal"] }))).toThrow(/not one of this wolf's subscribed domains/);
    expect(existsSync(join(roots.opsRoot, "inbox", WOLF))).toBe(false);
    expect(existsSync(join(roots.denLocal, "emitted.json"))).toBe(false);
  });

  it("does not check when the wolf's domains are unknown (none / empty list)", () => {
    expect(emitDelta(input("c", { domainHint: "snapjack" }))).not.toBeNull();
    expect(emitDelta(input("d", { denTopicId: "t2", domainHint: "snapjack", allowedDomains: [] }))).not.toBeNull();
  });
});
