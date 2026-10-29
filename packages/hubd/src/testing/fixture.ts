/** A small fixture ledger for tests: one feature with two tasks (and the domain Inbox createWork makes), written through kb work-ops. */
import { createWork, commitWorkItem, loadWorkState } from "@wolfpack/kb/client";
import { hubRoots } from "../layout.js";

export const FIXTURE_DOMAIN = "wolfpack";

export function seedFixture(dataDir: string): { feature: { id: string; title: string; kind: string }; tasks: string[] } {
  const roots = hubRoots(dataDir);
  const f = createWork(roots, { kind: "feature", domain: FIXTURE_DOMAIN, title: "Hub fixture feature", assignee: "1uk4" });
  const t1 = createWork(roots, { kind: "task", domain: FIXTURE_DOMAIN, title: "First task", assignee: "1uk4", partOf: f.id, successCriteria: "it works" });
  const t2 = createWork(roots, { kind: "task", domain: FIXTURE_DOMAIN, title: "Second task", assignee: "1uk4", partOf: f.id, successCriteria: "it also works" });
  const item = loadWorkState(roots).get(f.id)!;
  commitWorkItem(roots, item, "## Plan\n\nBuild it.\n\n## Record\n\nDecided things.\n");
  return { feature: { id: f.id, title: item.title, kind: item.kind }, tasks: [t1.id, t2.id] };
}
