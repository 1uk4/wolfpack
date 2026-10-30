/** A small fixture ledger for tests: one feature with two tasks, a graduated task, and the domain Inbox container (ensureInbox), written through kb work-ops. */
import { appendWorkLedger, createWork, ensureInbox, commitWorkItem, loadWorkState } from "@wolfpack/kb/client";
import { hubRoots } from "../layout.js";

export const FIXTURE_DOMAIN = "wolfpack";

export function seedFixture(dataDir: string): { feature: { id: string; title: string; kind: string }; tasks: string[]; graduated: string } {
  const roots = hubRoots(dataDir);
  ensureInbox(roots, FIXTURE_DOMAIN, "1uk4");
  const f = createWork(roots, { kind: "feature", domain: FIXTURE_DOMAIN, title: "Hub fixture feature", assignee: "1uk4" });
  const t1 = createWork(roots, { kind: "task", domain: FIXTURE_DOMAIN, title: "First task", assignee: "1uk4", partOf: f.id, successCriteria: "it works" });
  const t2 = createWork(roots, { kind: "task", domain: FIXTURE_DOMAIN, title: "Second task", assignee: "1uk4", partOf: f.id, successCriteria: "it also works" });
  const t3 = createWork(roots, { kind: "task", domain: FIXTURE_DOMAIN, title: "Graduated task", assignee: "1uk4", partOf: f.id, successCriteria: "done long ago" });
  appendWorkLedger(roots, [{ type: "work.graduated", id: t3.id, at: "2026-09-30T10:00:00.000Z" }]);
  const item = loadWorkState(roots).get(f.id)!;
  commitWorkItem(roots, item, "## Plan\n\nBuild it.\n\n## Record\n\nDecided things.\n");
  return { feature: { id: f.id, title: item.title, kind: item.kind }, tasks: [t1.id, t2.id], graduated: t3.id };
}
