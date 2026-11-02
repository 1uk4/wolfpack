/** storeContribution: a domain_hint outside the sending wolf's subscribed domains is refused and quarantined (defence in depth). */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { contentHash } from "@wolfpack/kb/shared";
import { ContributionError, storeContribution } from "./contributions.js";

const root = mkdtempSync(join(tmpdir(), "hubd-domainhint-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const make = (topic: string, hint?: string) => {
  const body = `Body of ${topic}.`;
  const json: Record<string, unknown> = {
    from: "hal2", denTopicId: topic, change: "create", contentHash: contentHash(body), prevHash: null,
    summary: "Summary line.", submitted: "2026-10-01 12:00", body, origin: "crawl", sourcePath: "/src",
    domainHint: hint ?? "personal",
  };
  return { text: JSON.stringify(json), json };
};
const actor = { id: "hal2", kind: "wolf" as const };
const stored = () => readdirSync(join(root, "hal2")).filter((f) => f.endsWith(".md"));

describe("storeContribution domain_hint guard", () => {
  it("stores an allowed hint", () => {
    expect(storeContribution(root, actor, make("ok", "personal"), root, ["personal"]).duplicate).toBe(false);
    expect(stored()).toHaveLength(1);
  });

  it("refuses a foreign hint and quarantines it", () => {
    expect(() => storeContribution(root, actor, make("bad", "wolfpack"), root, ["personal"])).toThrow(ContributionError);
    expect(() => storeContribution(root, actor, make("bad2", "snapjack"), root, ["personal"])).toThrow(/not one of the wolf's subscribed domains/);
    expect(stored()).toHaveLength(1); // only the allowed one
    expect(existsSync(join(root, "hal2", "_bad"))).toBe(true);
  });

  it("does not check when the subscriptions are unknown", () => {
    expect(storeContribution(root, actor, make("free", "wolfpack"), root).duplicate).toBe(false);
    expect(storeContribution(root, actor, make("free2", "snapjack"), root, []).duplicate).toBe(false);
  });
});
