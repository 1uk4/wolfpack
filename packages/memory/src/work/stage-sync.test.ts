import { describe, it, expect } from "vitest";
import type { WorkItem } from "@wolfpack/kb/client";
import { syncFeatureStage } from "./stage-sync.js";

const item = (id: string, stage: string, partOf?: string, extra: object = {}) => ({ id, stage, partOf: partOf ?? null, ...extra }) as unknown as WorkItem;

function fake(items: WorkItem[]) {
  const moves: string[] = [];
  return {
    moves,
    client: {
      get: async (id: string) => items.find((i) => i.id === id)!,
      stage: async (id: string, to: string) => {
        moves.push(`${id}->${to}`);
        return item(id, to);
      },
    },
  };
}

describe("syncFeatureStage", () => {
  it.each(["idea", "plan", "feasibility", "approved"])("moves a feature at %s to in_build", async (stage) => {
    const f = fake([item("feat", stage)]);
    const moved = await syncFeatureStage(f.client, item("t", "in_build", "feat"));
    expect(f.moves).toEqual(["feat->in_build"]);
    expect(moved).toHaveLength(1);
  });

  it("leaves a feature already in build or later alone", async () => {
    for (const stage of ["in_build", "shipped", "live", "archived"]) {
      const f = fake([item("feat", stage)]);
      await syncFeatureStage(f.client, item("t", "in_build", "feat"));
      expect(f.moves).toEqual([]);
    }
  });

  it("follows the chain up to an initiative, skips the Inbox, and does nothing for a parentless task", async () => {
    const f = fake([item("feat", "plan", "init"), item("init", "approved")]);
    await syncFeatureStage(f.client, item("t", "in_build", "feat"));
    expect(f.moves).toEqual(["feat->in_build", "init->in_build"]);

    const inbox = fake([item("inbox", "plan", undefined, { container: true })]);
    await syncFeatureStage(inbox.client, item("t", "in_build", "inbox"));
    expect(inbox.moves).toEqual([]);

    const lone = fake([]);
    expect(await syncFeatureStage(lone.client, item("t", "in_build"))).toEqual([]);
  });

  it("a Work API failure is swallowed", async () => {
    const client = { get: async () => { throw new Error("down"); }, stage: async () => item("x", "in_build") };
    expect(await syncFeatureStage(client, item("t", "in_build", "feat"))).toEqual([]);
  });
});
