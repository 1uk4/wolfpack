# Wolfpack Knowledge Base — Architecture

> How the shared knowledge base works **today**. Design history (the v1 graph,
> the phased v2 rebuild plan) lives in git: see `docs/kb-v2-implementation.md`
> at commit `d5a9439`. Crawl ingestion: `packages/memory/docs/crawl-spec.md`.
> The work layer (Factory): `docs/factory-design.md`.

## Principles
1. **Make illegal states unrepresentable.** Zod schemas are the single source of
   truth for every node's shape; branded ids, closed enums, discriminated kinds.
2. **The LLM is an opinion tool.** Each call returns a narrow, schema-validated
   result. It never emits an id, a date, a section, or a resolved link — code owns
   those, so a wrong answer cannot make the KB invalid.
3. **Determinism at the core.** Ids, dates, hashes, embeddings, centroids, tree
   placement, link resolution and validation are code.
4. **Behavior lives in editable config:** prompts, vocabularies, numeric knobs.
5. **One substrate, two layers:** the Library (durable entries) and the Factory
   (live work items, `docs/factory-design.md`).

---

## Where it runs
- **Authority:** Dewey, the librarian wolf, on **sfo-01** (wolf id `W1hOrJ`).
  KB at `/home/wolf-W1hOrJ/knowledge/base`; den-local state (ledger, sections,
  vectors) at `/var/lib/wolfpack-kb/W1hOrJ`. A systemd timer runs the sweep every
  15 minutes; the CLI is bundled to `/opt/wolfpack-kb/cli.cjs` by `wolf sync`.
- **Mirrors:** every other wolf gets each `domains/<domain>/` folder as a
  **receive-only** Syncthing share. Edits or deletions on a mirror never reach
  Dewey — change the KB on sfo-01 (e.g. `kb retire`), never by editing the mirror.
- **Contributions** flow wolf → `opsRoot/inbox/<wolf>/` → sweep. Wolves produce
  them by promoting den topics (`emitDelta`), crawling documents, or graduating
  shipped work.

## Layout
```
knowledge/base/domains/<domain>/
  entries/<kb-id>.md    curated entries (YAML frontmatter + body)
  INDEX.md              entry list (title + summary), rendered each sweep
  _registry.md          topic registry (aliases, subscribers), from the ledger
  _digest.json          section tree projection ("what the pack knows")
  work/<work-id>.md     Factory work items (see factory-design.md)
<denLocal>/
  ledger/events.jsonl   KB event log (append-only source of truth)
  sections/_sections.json   section tree snapshot
  vectors/              embedding cache (never synced)
```

## Code map
```
packages/engine/src/
  prompts.ts                  KB system prompts (SECTION_PICK, SECTION_SUMMARY,
                              LABEL_SECTION, CONTRADICT, PRODUCE) + dataflow diagram
  config/prompts/memory.ts    memory + crawl system prompts (re-exported by prompts.ts)
  config/vocab.ts             closed vocabularies (ENTRY_KINDS, WORK_KINDS, STAGES,
                              RELATION_KINDS, FACET_KEYS)
  config/tuning.ts            numeric knobs (EMBED, SWEEP, HIERARCHY, DIGEST)
packages/kb/src/
  schema/knowledge.ts         Entry, Section, LlmOpinion ⊕ DerivedFacts ⊕ CuratorOverrides
                              → assembleEntry()
  schema/work.ts              WorkItem + work events (Factory)
  shared/                     contribution/event/registry/digest schemas, ids, paths
  client/                     wolf side: emitDelta, work-store, work-ops (no LLM)
  librarian/                  Dewey side: sweep, route, hierarchy, sections, oracles,
                              produce, commit, domains (INDEX + digest), registry,
                              ledger, summarize, embed, intake, retire, observability
  cli.ts                      wolfpack-kb: status | sweep | reindex | rebuild-vectors
                              | reorg | retire
packages/kb/scripts/
  kb-health.mjs               section-tree health (balance, cohesion, summaries)
  backfill-sections.mjs       per-domain section-tree builder for a new domain
```

---

## The typed entry
```
LlmOpinion  ⊕  DerivedFacts  ⊕  CuratorOverrides  →  assembleEntry (pure)  →  Entry
(title·kind·    (id·dates·section·   (authority·          resolves link hints to real
 prose·facets·   placement·hash·      pins·verified)        ids, drops the rest,
 link HINTS)     currency·relations)                        validates)
```
`kind` is one of `ENTRY_KINDS`, or `other` with a required `tag`. `facets` is a
controlled map over `FACET_KEYS`; `properties` is an open string map for concrete
attributes (host, region, counts).

## The sweep (`librarian/sweep.ts`)
Per contribution, in order:
1. **Embed** the contribution (Ollama, `nomic-embed-text`).
2. **Identity:** a known alias (wolf + den topic) updates its existing entry; else a
   cosine ≥ `SWEEP.mergeSim` match does.
3. **Archive-safety:** an archived contribution older than a live entry never
   supersedes it (receipt + skip).
4. **Route:** descend the section tree by centroid cosine. When nothing fits,
   **`SECTION_PICK_SYSTEM`** picks a provided section id or `NEW` (a new section).
5. **Contradict** (conditional) → **Produce** (`PRODUCE_SYSTEM`, opinion only) →
   **assemble** → **commit**.
6. Re-render `INDEX.md`, `_digest.json` and `_registry.md` for touched domains.

A single-writer `sweep.lock` prevents concurrent sweeps.

## The section tree
Every entry belongs to exactly one section; sections nest (single parent). Knobs
live in `tuning.ts → HIERARCHY` (`fitThreshold`, `splitAt`, `mergeBelow`,
`crystallizeAt`, `minCohesion`, `maxDepth`). **`wolfpack-kb reorg [domain]`**
maintains it: fixes member counts, splits/merges/crystallizes, and re-summarizes
+ re-labels dirty sections (`SECTION_SUMMARY_SYSTEM`: one line ≤140 chars;
`LABEL_SECTION_SYSTEM`: 2–6 word title). `--resummarize-all` regenerates every
section after a prompt change; `--dry-run` previews.

## The digest (`_digest.json`)
A deterministic, hash-guarded projection of a domain's section tree: section
ids, titles, one-line summaries, currency, entry ids. Sections with no entries
in their subtree are omitted. Consumers:
- **Crawl consolidation** primes every batch with it ("PACK ALREADY KNOWS"),
  plus a running digest of the crawl's own finished batches.
- **Wolves' `<kb_access>` pointer** lists each domain's entry count and
  top-level section titles, so a wolf can tell when a domain is relevant.
- **Live memory is not primed.** Den promotion is a deterministic upsert (no LLM);
  merging across wolves is the sweep's job.

## Removing entries
`wolfpack-kb retire <entryId...> [--reason=…] [--dry-run]` on sfo-01 deletes the
entry files, records `entry_retired` in the ledger (the registry drops the entry,
and a topic left empty), and re-renders the registry, INDEX and digest. Run
`reorg <domain>` afterwards to refresh section member counts.

---

## Known gaps
- **Relations are never filled.** The sweep's relation resolver is a stub that
  returns `null`, so `assembleEntry` drops every proposed link.
- **`SWEEP.mergeSim`** (0.72) still needs calibrating against real re-promotes.
- **Work items are written into the receive-only mirror** on wolves
  (`domains/<d>/work/`), so they never reach sfo-01.
- Open cleanup tasks: `reorg` should take `sweep.lock`; KB `appendLedger` should
  validate events before writing; `reorg --dry-run` overstates relabels.
