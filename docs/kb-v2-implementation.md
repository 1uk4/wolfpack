# Wolfpack KB v2 — Implementation Guide

> Sequenced, delegatable plan to rebuild the knowledge base around a **hierarchical
> section tree** (hard single-parent backbone) + **typed relations** (soft overlay),
> a **digest-driven classifier**, and **emergent sections**. The graph is deleted.
> Companion design: `docs/kb-design.md`. Memory internals: `packages/memory/docs/crawl-spec.md`.

Status: **build complete (local), pending Dewey bring-up** · Target packages:
`@wolfpack/engine`, `@wolfpack/kb` (Factory deferred to a new package).

## Status: v2 is LIVE on Dewey (sfo-01)
- ✅ Phases 0–6 shipped. v1 retired — `sweepV2` is the only sweep (no `KB_V2` flag).
- ✅ **Migration complete on Dewey:** 17 wolfpack entries converted to v2 format
  (section tree + `placement`/`kind`/`maturity`/`currency`/`contentHash`, titles
  YAML-quoted); snapjack cleared to an empty shell for a fresh re-crawl.
- ✅ Deterministic registry + content-similarity identity + feed are live in the sweep.
- The one-shot `backfill-sections.mjs` migration script has been **removed** (its job
  is done; recover from git history if a new domain ever needs the same bootstrap —
  the proper home is a `kb backfill` CLI subcommand, see followups).
- Open followups: calibrate `SWEEP.mergeSim` against real re-promotes; add a
  `kb backfill` CLI command; implement the relation resolver (relations[] still empty).

---

## 0. Ground rules (read before any phase)

1. **The memory capture spine does not change.** `turn_end → observe → ledger →
   consolidate → den → emitDelta` stays load-bearing and untouched. All work lands
   downstream, at Dewey's **sweep** (classification + placement) and in the schema.
2. **Determinism at the core, LLM only at the edges.** Ids, dates, hashes,
   embeddings, centroids, tree descent, split/crystallize, link resolution,
   validation = code. The LLM only classifies into closed sets and writes prose.
3. **All LLM instructions live in config.** Every system prompt in
   `engine/src/prompts.ts`; every numeric knob in `engine/config/tuning.ts`; every
   closed vocabulary in `engine/config/vocab.ts`. No prompt text or threshold is
   ever inlined in logic.
4. **Every LLM output is a narrow Zod schema, validated on return.** Invalid output
   is rejected/retried, never committed. The schema is the hallucination firewall.
5. **Observability first.** New stages dump to `/tmp/wolfpack-kb/<run>/` before
   anything writes a real entry. Inert schemas + a `KB_V2` flag gate the cutover.
6. **Migration scope:** migrate the **wolfpack** domain only. **Delete snapjack
   entirely** — it is re-crawled fresh once the system is complete.

### The complete LLM surface (six calls — nothing else may call a model)

| Call | Stage | Model | Bounded input | Output schema (guard) | Confinement |
|---|---|---|---|---|---|
| `observe` | capture | weak | one chunk | `ObserverResultSchema` | single-line obs; ids verbatim; may emit zero |
| `consolidate` | memory | smart | overflow obs + topics + digest subset | `ConsolidationResultSchema` | action ∈ merge/create/skip per group |
| `classify` → section-pick | sweep route | weak | contribution + digest sections (enum) | `SectionPickSchema` | pick a supplied id or `NEW`; no free text |
| `produce` → opinion | sweep | smart | contribution + existing + section ctx | `LlmOpinion` | no ids/dates/structure; relations are hints |
| `section-summary` | crystallize | weak | child summaries (capped N) | `SectionSummarySchema` | summarize-only; input bounded |
| `contradict` | sweep oracle | weak | new vs existing | `ContradictSchema` | enum winner |

**Rule:** the LLM never emits an id, a date, a `section`, or a resolved relation.
Code owns all of those.

**Inventory reconciliation (per Wave 3 audit).** Beyond the six core calls, two
additive calls are sanctioned and schema-guarded: `journey` (crawl-only historical
arc, `JourneyResultSchema`) and `labelTopic` (deferred cluster-naming,
`LabelTopicResultSchema`). Two v1 calls — `classifyEntry` (old domain/subcategory
classify) and `produce` v1 (`EntrySchema`) — are LEGACY: still wired into the
current `sweep.ts` and **removed at the Wave 4 cutover** when the sweep switches to
`classifyToSection` + `produceEntry`. Every call site is Zod-guarded; none emit
ids/dates/sections/relations.

---

## Phase 0 — Control surface

**Goal:** the single editable home for all prompts, knobs, and vocab, before any
logic references it.

Files:
- `engine/config/tuning.ts` — delete `GRAPH`; add `HIERARCHY`; keep `DIGEST`; recalibrate `ROUTE`.
- `engine/config/vocab.ts` — confirm closed sets the LLM picks from.
- `engine/prompts.ts` — add/confine the new system prompts (dataflow-commented).
- new schema module — `SectionPickSchema`, `SectionSummarySchema`.

`HIERARCHY` shape:
```ts
export const HIERARCHY = {
  fitThreshold:   0.78,  // below this cosine to any child → park in _unplaced
  splitAt:        12,    // section members over this → split (BIRCH overflow)
  mergeBelow:     3,     // section under this → fold back into parent
  crystallizeAt:  4,     // parked entries forming a cohesive cluster → new section
  minCohesion:    0.80,  // silhouette floor for a crystallized section to be valid
  maxDepth:       4,     // cap descent
  rebuildCadence: "weekly",
} as const;
```

**Gate:** compiles; every prompt + knob + vocab editable in one place; no behavior change.

> ### Subagent brief — `prompt-cartographer` (or `worker`)
> **Context:** `engine/src/prompts.ts` already centralizes all system prompts with
> `// stage · model · in · out` comments (keep that convention verbatim). `engine/config/`
> holds `vocab.ts` + `tuning.ts`.
> **Task:** (1) In `tuning.ts`, remove `GRAPH`, add the `HIERARCHY` block above,
> keep `DIGEST`, and add a `// TODO(recalibrate)` note on `ROUTE` for tree-descent.
> (2) In `prompts.ts`, add `SECTION_PICK_SYSTEM` and `SECTION_SUMMARY_SYSTEM`,
> rewrite `CLASSIFY_SYSTEM` into a section-pick form ("choose exactly one of the
> provided section ids, or the literal NEW"), and extend `CONSOLIDATE_SYSTEM` +
> `CRAWL_CONSOLIDATE_SYSTEM` with a "PACK ALREADY KNOWS" block instruction. Keep
> wording confined and enum-oriented; never instruct the model to invent ids/dates.
> **Do NOT** change any consumer code yet. **Gate:** `tsc --noEmit` green across engine.

---

## Phase 1 — Schema & substrate (inert)

**Goal:** the typed contract for the tree + relations. Nothing imports it yet, so
editing is free.

Files:
- `kb/src/schema/knowledge.ts` — add `SectionId`, `Section`; add `section` +
  `placement.basis` to `DerivedFacts`/`Entry`; **remove** `cluster`, `centrality`,
  `role`, `integration`.
- `kb/src/shared/schemas/digest.ts` — re-point to a hierarchical section-tree projection.
- `kb/src/shared/schemas/events.ts` — add `section_created`, `section_split`,
  `entry_placed`, `crystallized_v2`.

Key invariants the schema must enforce: one `section` per entry (required,
resolvable); one `parent` per section (or root); relations target real ids.

**Gate:** unit tests — valid/invalid Entry, single-parent invariant, dangling
relation rejected. Nothing live changes.

> ### Subagent brief — `worker`
> **Context:** `kb/src/schema/knowledge.ts` is the v2 typed node (currently inert).
> `docs/kb-v2-implementation.md` §Phase 1 and `docs/kb-design.md` describe the shape.
> The `Section` schema, `SectionId` primitive, and the `section`/`placement` fields
> are specified in the design discussion (hard single-parent tree + soft relations).
> **Task:** implement the schema edits above with Zod, following the existing
> branded-primitive + three-layer (`LlmOpinion ⊕ DerivedFacts ⊕ CuratorOverrides`)
> style already in the file. Add `CuratorOverrides.pinnedSection?: SectionId`. Write
> `*.test.ts` covering the invariants. **Do NOT** wire into produce/sweep.
> **Gate:** `tsc --noEmit` + new tests green; no other file imports the changes.

---

## Phase 2 — Placement brain (pure, no LLM, `/tmp`-observable)

**Goal:** deterministic routing + emergent-section mechanics, testable in isolation.

Files:
- `kb/src/librarian/route.ts` — **rewrite:** flat nearest-neighbour → **tree descent**
  (centroid cosine per level) → section + nearest entry within section; below
  `fitThreshold` → `_unplaced`.
- `kb/src/librarian/clusters.ts` → **`hierarchy.ts`** — BIRCH-style overflow `split`
  + novelty `crystallize` from `_unplaced`; running-mean centroids.
- section-tree registry — `_sections.json` read/write/fold (mirror `ledger.ts` + `registry.ts`).

**Gate:** fixture tests — route determinism; split fires at `splitAt`; crystallize
fires at `crystallizeAt` with cohesion ≥ `minCohesion`; sparse strays stay parked.
Dump tree + routing decisions to `/tmp/wolfpack-kb/<run>/`. Still no LLM, still not
in the sweep.

> ### Subagent brief — `worker`
> **Context:** current `route.ts` (flat NN over all entry vectors) and `clusters.ts`
> (flat threshold crystallization) are pure functions with no LLM. `embed.ts`
> provides `cosine`. Knobs come from `HIERARCHY` (Phase 0). The section registry
> should follow the `foldRegistry`/`renderRegistry` pattern in `ledger.ts`/`registry.ts`.
> **Task:** (1) rewrite `routeContribution` to descend a `Section[]` tree by centroid
> cosine, returning `{ section, target?, basis, fit }` or an `_unplaced` verdict.
> (2) create `hierarchy.ts` with `maybeSplit(section)` (k-means on overflow) and
> `crystallizeUnplaced(parked)` (cluster → new sections at `crystallizeAt`/`minCohesion`).
> (3) add `_sections.json` read/write/fold. All deterministic. Write fixtures for a
> small synthetic tree. Dump artifacts to `/tmp/wolfpack-kb/<run>/`.
> **Gate:** tests green; zero LLM imports; nothing calls these from `sweep.ts` yet.

---

## Phase 3 — Confined LLM calls

**Goal:** wire the six-call surface, each behind a validated Zod schema.

Files:
- `kb/src/librarian/oracles.ts` — `classify` → section-pick (`SectionPickSchema`, enum from digest).
- `kb/src/librarian/produce.ts` — `produce` → `assembleEntry(LlmOpinion ⊕ DerivedFacts ⊕ CuratorOverrides)`;
  LLM returns only `LlmOpinion`; code injects `section` (Phase 2), ids, resolved relations.
- new `section-summary` call for dirty/crystallized sections.
- `commit.ts` / `normalize.ts` — write + hygiene v2 frontmatter (`section`, typed `relations`).

**Gate:** each call validated against its schema; a deliberately malformed model
output is rejected (prove the firewall); `assembleEntry` drops unresolved relation
hints rather than inventing ids.

> ### Subagent brief — `worker`
> **Context:** `produce.ts` is the one generative call; `oracles.ts` holds the small
> conditional calls. Prompts + schemas are already centralized (Phase 0) in
> `engine/prompts.ts` + the schema module. `assembleEntry` exists in `knowledge.ts`.
> **Task:** rewire `produce` to call the model for `LlmOpinion` only, then build
> `DerivedFacts` deterministically (id via `mkEntryId`, dates, `section` from the
> Phase 2 router, relations via nearest-neighbour id resolution of the LLM hints)
> and run `assembleEntry`. Rewire `oracles.classify` to section-pick. Add the
> `sectionSummary(engine, childSummaries)` call. Update `commit.ts`/`normalize.ts`
> for v2 frontmatter. **Gate:** malformed-output rejection test; unresolved hints
> dropped; `tsc` + tests green.
>
> ### Subagent brief — `reviewer` (gate)
> **Task:** audit Phase 3 against Ground rule 4 — confirm NO LLM call can emit an
> id/date/section/resolved-relation, every call validates its schema, and every
> prompt/knob is sourced from config (not inlined). Report any leak.

---

## Phase 4 — Digest producer + consumers

**Goal:** publish the section tree as the brief; consume it on both ingestion paths.

Files:
- `kb/src/librarian/domains.ts` — add `renderDomainDigest` + `_sections.json`,
  **hash-guarded** so the `generated` timestamp does not churn the Syncthing mirror.
- `memory/src/prompts.ts` (`buildConsolidatePrompt`) + `memory/src/crawl/consolidate.ts`
  — inject the primed subset ("PACK ALREADY KNOWS"); maintain the crawl **running digest**
  (`published ⊕ batches 1..N-1`, union by entryId, produced wins).

**Gate:** `emitDelta → intake` round-trip preserves temporal/currency/section;
digest is a deterministic projection of the tree; empty sweep = true no-op.

> ### Subagent brief — `worker`
> **Context:** `renderDomainIndex` in `domains.ts` is the model to mirror.
> `shared/schemas/digest.ts` (Phase 1) is the output contract. `tuning.ts → DIGEST`
> caps topics (`maxTopics`, `maxPrimedTopics`). Selection is title/keyword match
> wolf-side (no embeddings needed there).
> **Task:** implement `renderDomainDigest(roots, domain)` as a pure projection of
> the section tree (hash-guard the write, excluding `generated` from the diff). Add
> the primed-subset injection into `buildConsolidatePrompt` and the crawl
> `runningDigest`/`mergeRunningDigest`. **Gate:** round-trip test; deterministic
> digest bytes across sweeps with no entry change.

---

## Phase 5 — Sweep cutover + delete the graph

**Goal:** flip the sweep to v2 behind a flag; remove graph code.

Files:
- `kb/src/librarian/sweep.ts` — wire new route/hierarchy/produce behind `KB_V2=1`; flip when green.
- **delete** `kb/scripts/kb-graph.mjs`, `kb/scripts/kb-health.mjs` (not in runtime path).
- new `kb/scripts/kb-health.mjs` (v2) — **tree** metrics: balance/fanout, cohesion
  (silhouette), summary faithfulness, routing stability.

**Gate:** `kb-flow.test.ts` passes under the v2 path; old graph artifacts removed;
health report emits tree metrics.

> ### Subagent brief — `worker`
> **Context:** `sweep.ts` is a 9-stage pipeline; stages 3 (route), 4 (classify),
> 5 (produce), 7 (crystallize), 8 (index/digest) change. Keep stages 1,2,6,9
> intact. The `KB_V2` env flag selects old vs new route/produce.
> **Task:** wire the new modules into `sweep.ts` behind the flag; delete the two old
> graph scripts; write the v2 `kb-health.mjs` tree-metrics report. **Gate:**
> `kb-flow.test.ts` green under `KB_V2=1`; `rg` finds no remaining Louvain/PageRank
> references in the runtime path.

---

## Phase 6 — Migration (wolfpack only) + snapjack delete

**Goal:** wolfpack on v2; snapjack gone.

Steps:
1. **Delete the entire snapjack domain** (entries, index, digest, vectors). No migration.
2. One-shot `kb/scripts/backfill-sections.mjs` (dry-run default, `--apply`; mirror the
   old `normalize-kb.mjs` discipline): embed wolfpack entries → cluster → build the
   tree → LLM section summaries → stamp each entry's `section` + `placement.basis = "crystallized"`.
3. Validate: every wolfpack entry has a resolvable `section`; `_digest.json` builds;
   sweep on a clean inbox is a no-op.

**Gate:** wolfpack fully v2; snapjack absent; clean-inbox sweep = no-op.

> ### Subagent brief — `worker`
> **Context:** `normalize-kb.mjs` is the one-shot-migration pattern (dry-run default,
> `--apply`, git-committed). KB authority is sfo-01; Mac is a mirror — run migration
> where the authority is, or dry-run on the mirror first.
> **Task:** write `backfill-sections.mjs`: read wolfpack entries + vectors, build the
> section tree via the Phase 2 code, call `section-summary` per section, stamp
> `section` into each entry's frontmatter. Dry-run prints the proposed tree +
> placements; `--apply` writes + git-commits. Then delete snapjack. **Gate:**
> dry-run reviewed by a human before `--apply`; post-run validation passes.

---

## Phase 7 — Factory (deferred, additive)

New `@wolfpack/factory` package + a plans/completion extension. Reuses `Section`
(`placement.basis = "declared"`), `relations[]` (`references`/`graduated_from`/`blocks`),
and `engine/ledger/event-log.ts` (stage = fold over transition events). **Zero**
Library pipeline changes. Classification here is *declared + stage-machine*, not
embedding-routed — which is why it does not touch Phase 2's router.

---

## Sequencing & parallelism — agent deployment waves

Fan-out is allowed once the schema foundation lands, up to **3 concurrent agents**,
under one hard rule: **no two concurrent agents may edit the same file.** Ownership
below is partitioned so each wave's agents touch disjoint file sets.

```
WAVE 1  Phase 1 ── schema foundation ──────────────────── 1 agent   [BLOCKING]
          ▼  gate: typecheck + schema tests
WAVE 2  ┌─ Phase 2  placement brain (kb/librarian) ───────┐ 2 agents ∥
        └─ Phase 4-consumer  digest priming (memory) ─────┘
          ▼  gate: Phase 2 pure tests green
WAVE 3  ┌─ Phase 3a  oracles.classify → section-pick ─────┐
        ├─ Phase 3b  produce→assemble + commit + normalize ┤ 3 agents ∥
        └─ Phase 4-producer  renderDomainDigest (domains) ─┘
          ▼  gate: schema-firewall tests + reviewer sign-off
WAVE 4  Phase 5  sweep cutover + delete graph ──────────── 1 agent + reviewer [SERIAL]
          ▼
WAVE 5  Phase 6  wolfpack migration + snapjack delete ──── 1 agent + human gate [SERIAL]
```

**File ownership per wave (must stay disjoint within a wave):**

| Wave | Agent | Files | Depends on |
|---|---|---|---|
| 1 | schema | `knowledge.ts`, `digest.ts`, `events.ts`, `vocab.ts` (GraphRole) | Phase 0 |
| 2 | A (Phase 2) | `route.ts`, `hierarchy.ts`, `_sections.json` registry | Phase 1 |
| 2 | B (Phase 4-consumer) | memory `buildConsolidatePrompt`, `crawl/consolidate.ts` | Phase 1 (digest schema only) |
| 3 | C (Phase 3a) | `oracles.ts` | Phase 1 + 2 |
| 3 | D (Phase 3b) | `produce.ts`, `commit.ts`, `normalize.ts` | Phase 1 + 2 |
| 3 | E (Phase 4-producer) | `domains.ts` | Phase 1 + 2 |
| 4 | integrator | `sweep.ts`, scripts | 2 + 3 + 4 |
| 5 | migrator | `backfill-sections.mjs`, snapjack delete | 5 |

**Single-agent / serial on purpose:**
- Phase 1 — the three schema files cross-reference `SectionId`; one pass avoids type drift.
- Phase 5 — the integration point; needs every module present to wire `sweep.ts`.
- Phase 6 — migration with a human dry-run review before `--apply`.

A `reviewer` subagent signs off Wave 3 (schema firewall) and Wave 4 (cutover)
against the LLM-confinement rules before the next wave starts.

## Definition of done

- Memory capture spine unchanged and still green.
- All six LLM calls confined: prompt in `prompts.ts`, knobs in `tuning.ts`, output
  Zod-validated, no id/date/section/relation emitted by a model.
- wolfpack domain on the hierarchical section tree with a deterministic digest.
- snapjack deleted, ready for a fresh v2 crawl.
- graph code removed; health reports tree metrics.
