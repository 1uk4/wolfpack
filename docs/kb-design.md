# Wolfpack Knowledge Base — Design & Implementation Spec

> Canonical spec for the v2 typed knowledge base. Written to be implemented in a
> fresh session. Visual companion: `~/wolves/knowledge/base/maps/graph/show-me-kb-design.html`.

## Principles (after typesafe.ai/manifesto)
1. **Make illegal states unrepresentable.** The TypeScript type system is the single
   source of truth for a node's shape.
2. **The LLM is an opinion tool.** It returns a narrow, enum-constrained `LlmOpinion` —
   never a finished node. Its surface shrinks as fields move to deterministic derivation.
3. **Determinism at the core, nondeterminism at the edges.** Ids, dates, hashes,
   embeddings, clusters, centrality, link resolution, validation = code.
4. **Behavior lives in editable config**, not scattered in logic: prompts, vocabularies,
   numeric knobs — all in one place, tuned by hand as the system grows.
5. **One typed substrate, two layers:** Library (durable context) + Factory (live work).

## Goal
An agent subscribed to a domain gets its WorkItem and follows `references` straight into
the Library — gathering all needed context in one hop. Lived sessions and shipped work
graduate back into the Library, so the system compounds.

---

## Status legend
- ✅ built & compiling  · 🟡 designed/typed but inert (not wired) · ⬜ to build

## File map (current)
```
packages/engine/src/
  prompts.ts                 ✅ all 10 system prompts (centralized, dataflow-commented)
  config/vocab.ts            ✅ controlled vocabularies (NODE_TYPES, ENTRY_KINDS, WORK_KINDS,
                                STAGES, RELATION_KINDS, CONFIDENCE, MATURITY, CURRENCY, …)
  config/tuning.ts           ✅ numeric knobs (EMBED, GRAPH, RELATIONS, ROUTE, DIGEST, MATURITY_RULES)
  config/index.ts            ✅ control-surface barrel
  ledger/event-log.ts        ✅ createEventLog<E> — append-only JSONL + fold (the "database")
  schemas/entry.ts           ✅ LIVE v1 frontmatter schema (still used by the running pipeline)

packages/kb/src/
  schema/knowledge.ts        🟡 v2 typed node: branded ids, discriminated Kind, LlmOpinion ⊕
                                DerivedFacts ⊕ CuratorOverrides → assembleEntry(). NOT wired.
  shared/schemas/digest.ts   🟡 ContextDigest contract (live + crawl paths). NOT wired.
  librarian/produce.ts       ✅ v1 produce (LLM) → normalizeEntry → commit. To be replaced by assemble.
  librarian/normalize.ts     ✅ v1 deterministic guardrails (link hygiene, dates, id↔domain)
  librarian/domains.ts       ✅ renderDomainIndex (INDEX.md with [[wikilinks]])
  client/resolve.ts          ✅ resolveEntry / listEntries (wolf reads its KB mirror)

packages/kb/scripts/
  kb-graph.mjs               ✅ similarity graph → Louvain + PageRank → GEXF/JSON/HTML + MOC notes
  kb-health.mjs              ✅ health report (modularity, giant-component, silhouette, gaps, dups)
  normalize-kb.mjs           ✅ one-shot frontmatter migration (dry-run default, --apply)

artifacts (in the Obsidian vault, maps/):
  maps/_KB-MAP.md, community-*.md       auto MOC notes
  maps/graph/kb-graph.{html,gexf,json}  interactive map + Gephi export
  maps/graph/kb-health.{json}, KB-HEALTH.md
  maps/graph/show-me-kb-design.html     this design, visual
```

---

## Architecture

### Control surface (editable)
- `prompts.ts` — HOW the LLM is asked. 10 prompts, each `// stage · model · in · out`.
- `config/vocab.ts` — WHAT it may categorize into (closed sets; grow deliberately).
- `config/tuning.ts` — HOW MUCH (thresholds, graph params, digest size, merge bands).

### Substrate (shared)
`EventLog` (append-only + fold) · embeddings (cosine, nomic-embed-text) · typed `relations`
· domains (subscription + Syncthing mirror).

### Two layers (one `KnowledgeNode` base, discriminated by `nodeType`)
- **Library** `nodeType:"reference"` → **Entry**. Durable. Lifecycle: maturity/currency.
  Derived: Louvain `cluster`, PageRank `role`. Links: `see_also` + `part_of/refines`.
- **Factory** `nodeType:"work"` → **WorkItem**. Live. Lifecycle: **stage machine**
  (event-sourced). Owns assignee/project/status. Links: `references`→Library, `blocks`.
- Cross-layer: `references` (work→context), `graduated_from` (entry←shipped work).

### The typed core (assembly)
```
LlmOpinion  ⊕  DerivedFacts  ⊕  CuratorOverrides  →  assembleEntry (pure)  →  KnowledgeNode
(title·kind·    (id·dates·cluster·  (authority·        resolves link hints to      (always valid)
 prose·conf·     centrality·role·    maturity·pins)     real ids, drops the rest,
 link HINTS)     relations·integration)                 validates)
```
The LLM never emits a node. Code re-derives ids and resolves every proposed link against
the real id set. The LLM can be wrong; it cannot make the KB invalid.

### What the linking analysis said to ADD (all derived, not LLM)
`cluster` (Louvain) · `centrality`+`role` (PageRank) · typed `relations[]` (two-layer) ·
`integration` (gap signal) · `maturity` (lifecycle). Hierarchy (`part_of` backbone) fixes
**connectivity**; **coverage** is fixed by reclassification + authoring (orthogonal).

---

## Ingestion — both paths, Dewey-primed by the digest

Dewey publishes `domains/<d>/_digest.json` each sweep (like INDEX): canonical topics +
summaries + vocabulary + gaps + journey. Rides the Syncthing mirror. Both paths consume it.

**Live** (`memory/consolidate`): inject the relevant subset into `buildConsolidatePrompt`
as a "PACK ALREADY KNOWS" block → KB-aware delta (merge vs restate, correct kind at
source, real `references` ids).

**Crawl** (`memory/crawl/consolidate`): same, plus three crawl-specific behaviors —
1. **Extend the real entry**: `existing` resolves from `digest.topics[match]` (Dewey's
   canonical entry), not a parallel one.
2. **Currency-aware**: digest topics carry `currency`; an archived crawl batch layers dated
   history UNDER a live topic, never overwrites it (archived-vs-live guard at source).
3. **Running digest**: `runningDigest(batchN) = published ⊕ topics produced by batches 1..N-1`
   (crawl outruns the sweep timer; prevents intra-crawl dups). Oldest→newest.
4. **Journey continuation**: `digest.journey` feeds CRAWL_JOURNEY so it extends the narrative.

Information-granularity ladder: `utterance/doc → observation → den/crawl topic →
contribution(delta) → Entry`.

---

## Factory flow (stage machine)
`IDEA → PLAN → FEASIBILITY → [APPROVED*] → IN_BUILD → PR → [MERGE master*] = shipped → LIVE → graduate → Entry`
Every transition is an `EventLog` event; live state is a fold (history + time-travel free).
`*` gates are config flags → shrink toward zero as confidence grows ("self-sustaining agent").
Stages + legal transitions live in factory config (per project).

---

## Implementation roadmap (in order)

1. ⬜ **Wire `produce → assembleEntry`** (the v2 foundation).
   - Move `knowledge.ts` vocab imports onto `engine/config/vocab.ts` (single source).
   - Promote `KnowledgeNode` base (engine) so Entry + WorkItem share it.
   - `produce` returns only `LlmOpinion`; new deterministic derivers build `DerivedFacts`:
     - `cluster`/`role` from the embedding graph (reuse kb-graph core — factor
       `scripts/lib/graph-core.mjs` or port into `librarian/graph.ts`).
     - two-layer `relations`: embedding `see_also` (RELATIONS knobs) + resolved LLM edges
       (RelationResolver = nearest-neighbor id lookup) + `part_of` to cluster/topic.
   - `assembleEntry` (already in knowledge.ts) → `commit`. Update renderer for v2 fields
     (keep `[[wikilink]]` relations; canonical key order already in engine commit.ts).
2. ⬜ **Digest producer**: `librarian/renderDomainDigest(roots, domain)` → `_digest.json`
   each sweep, alongside `renderDomainIndex`. Topics from entries (+currency), vocab from
   config, journey from crawl journey if present.
3. ⬜ **Digest consumers**:
   - live: feed subset into `buildConsolidatePrompt`; update `CONSOLIDATE_SYSTEM`.
   - crawl: feed `existing`+`currency`+running-digest into `crawl/consolidate`; update
     `CRAWL_CONSOLIDATE_SYSTEM`; feed `journey` into `crawl/journey`.
4. ⬜ **Migrate `wolfpack` domain only** to v2 (snapjack will be RE-CRAWLED fresh — no
   snapjack migration). Then re-crawl snapjack through v2 + digest = the end-to-end test.
5. ⬜ **`@wolfpack/factory` package**: WorkItem events + stage-machine config on
   `EventLog`. `factory → engine (+ kb)`. Deterministic transitions; LLM drafts content.
6. ⬜ (deferred) **Feedback loop**: emit `kb-health.json` each sweep; gap-directed capture.
7. ⬜ (opportunistic) refactor kb + memory ledgers onto `engine` `EventLog` (pays down
   the existing duplication the extraction was based on).

## Notes / decisions already made
- KB authority is **sfo-01** (`/home/wolf-W1hOrJ/knowledge/base`); Mac is a Syncthing
  mirror. Deploy code via `wolfpack sync dewey`. Vectors are den-local to Dewey
  (`/var/lib/wolfpack-kb/W1hOrJ/vectors`), never synced.
- Prompts were centralized by the `prompt-cartographer` subagent (verbatim; build green).
- `engine/src/config.ts` (model/runtime config) is a DIFFERENT concern from `config/`
  (knowledge control surface) — rename later if confusing.
- Current KB health baseline: 82/100 (B) — strong structure (modularity 0.46, small-world),
  weak on connectivity (one orphan) and coverage (3/12 kinds — fixed by v2 reclassification).
