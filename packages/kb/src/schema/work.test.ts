import { describe, it, expect } from "vitest";
import {
  WorkId,
  WolfId,
  foldWork,
  projectWork,
  parseWorkEvent,
  assertAdvanceable,
  type WorkEvent,
  type WorkItem,
} from "./work.js";
import { DomainId, Slug, EntryId } from "./knowledge.js";

const id = (s: string) => WorkId.parse(s);
const wolf = (s: string) => WolfId.parse(s);
const dom = (s: string) => DomainId.parse(s);

// A snapjack/marketing feature with one task under it.
const feature = id("work-snapjack-Ft00001");
const task = id("work-snapjack-Tk00002");

const events: WorkEvent[] = [
  {
    type: "work.created",
    id: feature,
    at: "2026-10-09 10:00",
    kind: "feature",
    domain: dom("snapjack"),
    title: "referral program",
    assignee: wolf("1uk4"),
    area: Slug.parse("marketing"),
    partOf: null,
    successCriteria: null,
    stage: "plan",
  },
  {
    type: "work.created",
    id: task,
    at: "2026-10-09 10:05",
    kind: "task",
    domain: dom("snapjack"),
    title: "wire referral codes",
    assignee: wolf("1uk4"),
    area: Slug.parse("marketing"),
    partOf: feature,
    successCriteria: "code redeems → credit applied",
    stage: "plan",
  },
  { type: "work.staged", id: task, at: "2026-10-09 11:00", to: "in_build" },
  { type: "work.noted", id: task, at: "2026-10-09 11:30", text: "codes generate; redemption WIP" },
  { type: "work.linked", id: task, at: "2026-10-09 12:00", rel: "references", target: "kb-snapjack-aB3xZ9k" },
  { type: "work.assigned", id: task, at: "2026-10-09 12:10", assignee: wolf("hal") },
];

describe("foldWork", () => {
  it("projects the current state of every work item", () => {
    const items = foldWork(events);
    expect(items.size).toBe(2);

    const f = items.get(feature)!;
    expect(f.kind).toBe("feature");
    expect(f.area).toBe("marketing");
    expect(f.partOf).toBeNull();

    const t = items.get(task)!;
    expect(t.stage).toBe("in_build"); // last staged event wins
    expect(t.partOf).toBe(feature); // the work tree
    expect(t.area).toBe("marketing"); // inherited (set at creation)
    expect(t.assignee).toBe("hal"); // reassigned from 1uk4 → hal
    expect(t.log).toHaveLength(1);
    expect(t.references).toEqual([EntryId.parse("kb-snapjack-aB3xZ9k")]);
    expect(t.updated).toBe("2026-10-09"); // last event date
  });

  it("is a pure fold — same events, same result", () => {
    expect(foldWork(events)).toEqual(foldWork(events));
  });

  it("skips events for an unknown id instead of throwing", () => {
    const orphan: WorkEvent[] = [
      { type: "work.staged", id: id("work-snapjack-Zz99999"), at: "2026-10-09 09:00", to: "shipped" },
    ];
    expect(foldWork(orphan).size).toBe(0);
  });

  it("projectWork returns one item or null", () => {
    expect(projectWork(events, task)?.title).toBe("wire referral codes");
    expect(projectWork(events, id("work-snapjack-NoSuch0"))).toBeNull();
  });
});

describe("parseWorkEvent", () => {
  it("accepts a valid event and rejects junk", () => {
    expect(parseWorkEvent(events[0])).not.toBeNull();
    expect(parseWorkEvent({ type: "work.bogus", id: "x" })).toBeNull();
    expect(parseWorkEvent({ type: "work.created", id: "not-a-work-id" })).toBeNull();
  });
});

describe("assertAdvanceable", () => {
  const taskNoCriteria: WorkItem = {
    id: task,
    nodeType: "work",
    kind: "task",
    domain: dom("snapjack"),
    area: Slug.parse("marketing"),
    title: "x",
    summary: null,
    stage: "plan",
    assignee: wolf("1uk4"),
    successCriteria: null,
    partOf: null,
    references: [],
    dependsOn: [],
    blocks: [],
    graduatedTo: [],
    log: [],
    created: "2026-10-09" as never,
    updated: "2026-10-09" as never,
  };

  it("blocks a task from leaving plan without a success criterion", () => {
    expect(assertAdvanceable(taskNoCriteria, "in_build")).toMatch(/success_criteria/);
  });

  it("allows it once a criterion is set", () => {
    const ok = { ...taskNoCriteria, successCriteria: "it works" };
    expect(assertAdvanceable(ok, "in_build")).toBeNull();
  });

  it("does not require a criterion for non-task kinds", () => {
    const feat = { ...taskNoCriteria, kind: "feature" as const };
    expect(assertAdvanceable(feat, "in_build")).toBeNull();
  });
});
