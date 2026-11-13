/**
 * Absorbed-topic recognition, for the migration of a den that predates the promote pass. The KB already holds most of
 * the session topics; the proof is in the den:
 *   - the distill record (`<den>/kb/distill/<id>.json`): its rawHash equals the hash of the topic's current body and it
 *     was not held, so exactly this body was distilled; its outputs' targets are the entry ids;
 *   - the archived den topic (`<den>/memory/archive/<id>.md`, newest stint): `absorbed_into` names the entry and the
 *     topic has not been updated since `absorbed_at`.
 * Such a topic gets a confirmed create/merge receipt in the promote state (so the retire rule and the byte cap treat it
 * as done). A topic updated since, or with no record, is left alone: the pass promotes it.
 */
import { contentHash } from "@wolfpack/kb/shared";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readResendTopics } from "./den.js";
import { topicActivity } from "./promote-pass.js";
import { readPromoteState, updateTopicState } from "./promote-state.js";
import { readTopics } from "./session/memory.js";

const asUtc = (s: string): Date => new Date(`${s.trim().replace(" ", "T")}${/(Z|[+-]\d\d:?\d\d)$/.test(s.trim()) ? "" : "Z"}`);

function distilledEntries(denLocal: string, id: string, body: string): { at: string; entryIds: string[] } | null {
  try {
    const p = join(denLocal, "distill", `${id}.json`);
    if (!existsSync(p)) return null;
    const rec = JSON.parse(readFileSync(p, "utf-8")) as { rawHash?: string; at?: string; held?: string; outputs?: Array<{ target?: string }> };
    if (rec.held || rec.rawHash !== contentHash(body)) return null;
    const entryIds = [...new Set((rec.outputs ?? []).map((o) => o.target).filter((x): x is string => typeof x === "string" && x.length > 0))];
    return entryIds.length ? { at: rec.at ?? new Date(0).toISOString(), entryIds } : null;
  } catch {
    return null;
  }
}

export function reconcileAbsorbed(o: { den: string; root: string; denLocal?: string }): { confirmed: string[] } {
  const denLocal = o.denLocal ?? join(o.den, "kb");
  const archived = new Map(readResendTopics(o.den).archived.map((a) => [a.id, a]));
  const confirmed: string[] = [];
  for (const t of readTopics(o.root)) {
    if (readPromoteState(o.den).topics[t.id]?.receipt) continue;
    let found = distilledEntries(denLocal, t.id, t.body);
    if (!found) {
      const a = archived.get(t.id);
      const at = a?.absorbedAt ? asUtc(a.absorbedAt) : null;
      const activity = topicActivity(t);
      if (a?.absorbedInto && at && !Number.isNaN(at.getTime()) && (activity === null || activity <= at)) found = { at: at.toISOString(), entryIds: [a.absorbedInto] };
    }
    if (!found) continue;
    updateTopicState(o.den, t.id, { promotedAt: found.at, receipt: { outcome: "merge", entryIds: found.entryIds } });
    confirmed.push(t.id);
  }
  return { confirmed };
}
