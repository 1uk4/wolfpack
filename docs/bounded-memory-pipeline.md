# Bounded memory pipeline — design document

**Status:** design-only. Companion to work items `work-wolfpack-YGx1F3C` (feature), `work-wolfpack-zxKrUVS` (design spike), and the build task created alongside it.

Do NOT build without first revisiting whether a newer paradigm (code mode, pi-durable task graph, future KB primitive) has made this approach obsolete. The underlying problem (unbounded accumulation at each layer) will persist across tool evolution; the specific solution shape may not.

---

## Problem architecture

The memory pipeline is **append-only at every layer**. Nothing removes content:

```
observations (per-session, each tagged with domain)
   ↓ consolidation (LLM groups by topic, appends to <topic>.md)
den topics (one file per topic, grows every session)
   ↓ /wolf:promote (emits delta file for each changed topic)
librarian inbox (deltas waiting for Dewey's sweep)
   ↓ sweep (route → embed → placeEntry → produce → commit)
KB entries (one file per entry, grows every merge)
```

Two independent accumulation loops:

**Loop 1 — den topic growth.** Every session's observations about an existing subject get consolidated INTO the matching topic file. No trigger splits a topic when it crosses a usable size. Over months, a single topic becomes a chronological journal of every observation ever made about that subject.

**Loop 2 — KB entry growth.** Every delta that merges into an existing entry increases that entry's size. No trigger splits an entry when it gets too large. The LLM produce call is bounded by output tokens (~16k for sonnet). Above a threshold, the merge output truncates, JSON extraction fails, and the item re-queues indefinitely.

---

## Downstream effects

The two loops compound:

1. Large den topic produces a large delta
2. Large delta + large target entry → merge needs to output >8k chars
3. LLM hits output budget → truncates → JSON extraction fails
4. Sweep stalls on that item for 3+ minutes per attempt (3 retries × ~65s each)
5. After 3 failed sweeps the item parks; user must manually intervene
6. The den topic keeps growing between sessions, so re-trying only gets worse
7. One bad topic can delay a batch of good contributions behind it in the inbox

**Observed Oct 16 2026:** `kb-section-tree-algorithm` den topic grew to ~10k chars during a week of debugging work. Promote emitted a delta trying to merge into `kb-wolfpack-UbWXWMv` (already 12k chars). Produce LLM call took 197s across 3 retries; JSON extraction failed each time. Item parked. Four historical versions of this same topic were already in the parked queue — this failure mode has recurred for weeks.

---

## Solution direction: cap size at the den layer

The pipeline is well-behaved when inputs are small. If a den topic stays under some size, deltas stay small, merge outputs fit in the token budget, nothing stalls. The fix lives at the SOURCE.

**Core shape of the sharding approach:**
- A topic that exceeds a soft size threshold gets split into 2–3 subtheme shards
- Each shard has its own id, title, anchor terms, content, immutable slug
- The parent topic becomes a directory with a `_registry.yaml` listing its shards
- New observations route to the appropriate shard (anchor-term match + embedding fallback + `misc.md` safety net)
- Promote emits one delta per shard with a `shards_of` metadata hint
- The KB sees N small contributions instead of one bloated merge
- The clustering (section tree with `mergeSimilarRoots` + `promoteDominantChildren`, built Oct 16 2026) naturally groups sibling shards back under one section — no manual grouping needed on the KB side

**Interaction with existing domain tagging:**
- Observations are tagged with `domain` at the observer layer (`packages/memory/src/observer/schemas.ts`)
- Topic schema carries `domain` (`packages/memory/src/schemas.ts`)
- Consolidation reads it to set the delta's `domain_hint` (`packages/memory/src/consolidate.ts`)
- Sharding rule: each shard inherits its parent topic's domain. One topic → one domain → one KB domain subscription for all its shards. No cross-domain complication.

---

## Phased expansion (reference only — do not build without revisit)

| Phase | Scope | Characteristic |
|---|---|---|
| MVP | Data model (topic = file OR dir), manual `shard_topic` tool, per-shard promote. New obs on sharded topics land in `misc.md`. | Admin-triggered only |
| 2 — Routing | Anchor-term match during consolidation; obs route to best-matching shard. `misc.md` as fallback. | Automated routing |
| 3 — Embedding fallback | When anchor confidence is low, cosine-similarity obs embedding against each shard. | Smarter routing |
| 4 — Auto-trigger | Background shard pass fires when any topic/shard exceeds threshold or when `misc.md` grows too large. | Automated splitting |
| 5 — Admin ops | `shard_lock`, `shard_merge`, `shard_promote_to_topic`, `shard_retire`. | Curation surface |
| 6 — KB-side consumption | `shards_of` metadata lets the KB show sibling groupings and treat retire-of-shard as retire-of-delta-chain. | Cross-layer awareness |

Each phase is additive and non-breaking relative to the one before.

---

## Why we're NOT building this now (Oct 2026 context)

For a single-wolf KB at ~70 entries with one promoter writing roughly weekly:
- Manual subagent cleanup is cheaper than building the infrastructure
- The failure mode is rare enough that attention per month suffices
- The automation complexity needs real volume to justify

**Deferral strategy:** spawn a cleanup subagent with file tools when the sweep complains. Have it scan topics, flag oversized ones, propose splits/merges/retirements, write new topic files. Zero infrastructure, zero code changes, uses existing tool surface.

**Triggers to flip from manual cleanup to automated sharding:**
1. Manual cleanups needed more than once a month
2. A second wolf starts writing to the wolfpack domain (nobody can eyeball the full den anymore)
3. A manual split produces drift (duplicates created across sessions because the LLM routed new obs to the wrong fragment)

When any of these fires, the companion build task picks up from here.

---

## Important caveat for the future

The wolfpack tool is evolving fast. By the time this design becomes relevant to build, there may be better paradigms available:
- **pi-durable task graphs** could express the shard pass as a durable scheduled task with built-in idempotency instead of ad-hoc file ops
- **code mode** could let the shard proposer run as a sandboxed script rather than a tool call, giving richer composition
- **a future KB primitive** (shared with Dewey's reorg) could make entry-level splitting a first-class operation, bypassing the need to shard at the den layer entirely

Before building, re-examine whether the pipeline-shape assumptions still hold. The problem (unbounded accumulation) is real and will outlive specific solutions; the SHAPE of the solution should match whatever abstractions exist at build time, not what existed when this doc was written.

---

## Open design questions (unresolved at write time)

1. **Shard-id convention for delta emission.** `topic--slug` (double-dash) vs `topic/slug` (slash) vs `topic.slug` (dot). Affects KB entry id generation.
2. **Does `shard_topic` always ask an LLM, or support admin override (`shard_topic X --shards a,b,c`)?** Probably both — LLM proposes, admin can override.
3. **First-emit for a newly-sharded topic: fresh `prev_hash: null` per shard, or inherit the pre-shard topic's hash chain?** Fresh is simpler. Inherit preserves continuity.
4. **Does `misc.md` emit to KB on promote?** If yes, more surface area for the KB clustering to handle. If no, risk of dropping real content.
5. **What's the right scheduler for the auto shard pass (phase 4)?** pi-durable native setInterval (matches the sweep pattern), or a self-rescheduling durable task (observable in `taskGraph`)?

These were discussed Oct 16 2026 but not resolved. Revisit at build time with the paradigm available then.

---

## Companion work items

- `work-wolfpack-YGx1F3C` — Feature: Bounded memory pipeline (parent)
- `work-wolfpack-zxKrUVS` — Spike: this design document
- `work-wolfpack-<build-id>` — Task: Build shard infrastructure MVP (deferred until trigger)
