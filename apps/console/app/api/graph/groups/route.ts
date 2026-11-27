/**
 * GET/PUT /api/graph/groups — the graph's visual domain groups (work-wolfpack-FnzgC6g), shared by the whole pack: stored on the hub
 * as pref `graph.groups`, with the console file (data/graph/groups.json) as the fallback when no hub answers.
 * See src/server/kb/groups-api.ts for the rules.
 *
 *   GET → 200 { groups: [...] } (empty list when none saved)
 *   PUT → body { groups: [...] } replaces the list; 200 the sanitized list actually stored (one group per domain)
 */
import { createGroupsApi, readGraphGroups, writeGraphGroups } from "@/src/server";

export const dynamic = "force-dynamic";

const api = createGroupsApi({ readLocal: () => readGraphGroups(), writeLocal: writeGraphGroups });

export const GET = (req: Request) => api.get(req);
export const PUT = (req: Request) => api.put(req);
