import { describe, it, expect } from "vitest";
import {
  WorkId,
  WolfId,
  foldWork,
  projectWork,
  parseWorkEvent,
  assertAdvanceable,
  isComplete,
  placementError,
  isBindable,
  type WorkEvent,
  type WorkItem,
} from "./work.js";
import { DomainId, Slug } from "./knowledge.js";

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
    container: false,
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
    container: false,
  },
  { type: "work.staged", id: task, at: "2026-10-09 11:00", to: "in_build" },
  { type: "work.noted", id: task, at: "2026-10-09 11:30", text: "codes generate; redemption WIP" },
  // Legacy work → KB links still parse: references is dropped, graduated_to
  // becomes the graduation date.
  { type: "work.linked", id: task, at: "2026-10-09 12:00", rel: "references", target: "kb-snapjack-aB3xZ9k" },
  { type: "work.linked", id: feature, at: "2026-10-09 12:05", rel: "graduated_to", target: "kb-snapjack-Ft00001" },
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
    expect(t).not.toHaveProperty("references");
    expect(t.graduated).toBeNull();
    expect(f.graduated).toBe("2026-10-09");
    expect(f).not.toHaveProperty("graduatedTo");
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
    dependsOn: [],
    blocks: [],
    graduated: null,
    container: false,
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

describe("isComplete", () => {
  it("is true from shipped onward and false before", () => {
    const at = (stage: string) => isComplete({ stage } as Pick<WorkItem, "stage">);
    expect(["shipped", "live", "archived"].map(at)).toEqual([true, true, true]);
    expect(["idea", "plan", "feasibility", "approved", "in_build"].map(at)).toEqual([false, false, false, false, false]);
  });
});

describe("placementError / isBindable", () => {
  const p = (kind: string, domain = "wp", container = false) =>
    ({ id: "work-wp-aaaaaaa", kind, domain, title: kind, container }) as any;
  const c = (kind: string, domain = "wp") => ({ kind, domain }) as any;

  it("encodes initiative → feature → task/issue/spike; ideas standalone", () => {
    expect(placementError(c("feature"), p("initiative"))).toBeNull();
    expect(placementError(c("feature"), null)).toBeNull();
    for (const k of ["task", "issue", "spike"]) {
      expect(placementError(c(k), p("feature"))).toBeNull();
      expect(placementError(c(k), p("initiative"))).toMatch(/only sit under a feature/);
      expect(placementError(c(k), null)).toMatch(/needs a feature/);
    }
    expect(placementError(c("initiative"), p("initiative"))).toMatch(/cannot have a parent/);
    expect(placementError(c("idea"), p("feature"))).toMatch(/cannot have a parent/);
    expect(placementError(c("task", "other"), p("feature"))).toMatch(/domain/);
  });

  it("only tasks, issues and spikes are bindable", () => {
    expect(["task", "issue", "spike", "feature", "initiative", "idea"].map((k) => isBindable({ kind: k } as any)))
      .toEqual([true, true, true, false, false, false]);
  });
});

describe("work.graduated", () => {
  it("sets the graduation date, once", () => {
    const g = foldWork([...events, { type: "work.graduated", id: task, at: "2026-10-11 09:00" }]);
    expect(g.get(task)!.graduated).toBe("2026-10-11");
  });
});
