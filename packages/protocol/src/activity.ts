/**
 * Live pack map: the versioned ActivityEvent a wolf publishes and the hub fans out (`pack.activity`).
 *
 * PRIVACY: an event says WHO did WHAT to WHICH thing, nothing more. `title` is short display text only (trimmed, cut to
 * ACTIVITY_TITLE_MAX chars). Never put content, tool args, snippets or tool output in any field.
 *
 * Compatibility: unknown extra fields are stripped, never rejected. An unknown verb / actor kind / target kind, or a `v`
 * above 1, drops THAT event (reason in `parseActivityEvent`), never the batch. `ts` is epoch milliseconds.
 */
import { z } from "zod";

export const ACTIVITY_VERSION = 1 as const;
export const ACTIVITY_TITLE_MAX = 120;
export const ACTIVITY_TTL_MAX_MS = 60 * 60 * 1000;
export const ACTIVITY_BATCH_MAX = 100;

export const ACTIVITY_VERBS = [
  "thread-active", "thread-idle", "bound", "unbound", "subagent-spawned", "subagent-finished",
  "kb-read", "kb-write", "contribution", "shipped", "needs-you", "answered", "owner-viewing",
] as const;
export type ActivityVerb = (typeof ACTIVITY_VERBS)[number];
export const ACTIVITY_ACTOR_KINDS = ["wolf", "thread", "subagent", "owner"] as const;
export const ACTIVITY_TARGET_KINDS = ["kb-entry", "kb-section", "work-item", "thread"] as const;

/** Trim and cut a display title to ACTIVITY_TITLE_MAX chars (over-long titles are trimmed, not rejected). */
export function sanitizeActivityTitle(title: string): string {
  return title.trim().slice(0, ACTIVITY_TITLE_MAX).trim();
}
const Title = z.string().transform(sanitizeActivityTitle).optional();

export const ActivityActorSchema = z.object({
  kind: z.enum(ACTIVITY_ACTOR_KINDS),
  wolf: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  subagent: z.string().min(1).optional(),
  parentThreadId: z.string().min(1).optional(),
  title: Title,
});
export type ActivityActor = z.infer<typeof ActivityActorSchema>;

export const ActivityTargetSchema = z.object({
  kind: z.enum(ACTIVITY_TARGET_KINDS),
  id: z.string().min(1),
  domain: z.string().min(1).optional(),
  title: Title,
});
export type ActivityTarget = z.infer<typeof ActivityTargetSchema>;

export const ActivityEventSchema = z.object({
  v: z.literal(ACTIVITY_VERSION),
  id: z.string().min(1),
  pack: z.string().min(1),
  ts: z.number().int().nonnegative(),
  ttlMs: z.number().int().positive().max(ACTIVITY_TTL_MAX_MS),
  actor: ActivityActorSchema,
  verb: z.enum(ACTIVITY_VERBS),
  target: ActivityTargetSchema.optional(),
  domain: z.string().min(1).optional(),
});
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

/** Ingest request body. `events` stays unvalidated here so one bad event cannot fail the batch; use parseActivityBatch. */
export const ActivityBatchSchema = z.object({
  v: z.literal(ACTIVITY_VERSION),
  events: z.array(z.unknown()).max(ACTIVITY_BATCH_MAX),
});
export type ActivityBatch = { v: 1; events: ActivityEvent[] };

export type ParseActivityResult =
  | { ok: true; event: ActivityEvent }
  | { ok: false; reason: "unsupported-version" | "invalid" };

export function parseActivityEvent(x: unknown): ParseActivityResult {
  if (x && typeof x === "object" && typeof (x as { v?: unknown }).v === "number" && (x as { v: number }).v > ACTIVITY_VERSION) {
    return { ok: false, reason: "unsupported-version" };
  }
  const r = ActivityEventSchema.safeParse(x);
  return r.success ? { ok: true, event: r.data } : { ok: false, reason: "invalid" };
}

/** Keep the valid events, count the rest. Over ACTIVITY_BATCH_MAX entries, or a non-array, is rejected whole. */
export function parseActivityBatch(xs: unknown):
  | { ok: true; events: ActivityEvent[]; dropped: number }
  | { ok: false; reason: "not-array" | "too-large" } {
  if (!Array.isArray(xs)) return { ok: false, reason: "not-array" };
  if (xs.length > ACTIVITY_BATCH_MAX) return { ok: false, reason: "too-large" };
  const events: ActivityEvent[] = [];
  for (const x of xs) {
    const r = parseActivityEvent(x);
    if (r.ok) events.push(r.event);
  }
  return { ok: true, events, dropped: xs.length - events.length };
}
