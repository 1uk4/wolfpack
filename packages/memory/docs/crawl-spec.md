# Crawl — reproducing the memory pipeline across time

Status: spec (v2 — template-faithful)
Package: `@wolfpack/memory` (new `crawl/` module) + small seams in `@wolfpack/kb`

## 1. Principle

The memory extension already turns a stream of events into durable, current-state
knowledge **plus** a dated narrative of how it got there. A crawl is **that same
pipeline run across time**: a historical document is a conversation chunk, and its
*recovered date* is the timestamp.

```
LIVE :  conversation chunk  → observe → ledger → consolidate → topics + journey → den → emitDelta → Dewey
CRAWL:  historical document → observe → ledger → consolidate → topics + journey → den → emitDelta → Dewey
        [-- deterministic front-end: WHICH docs, WHAT order, dates/domain/currency --]
```

We change as little of the template as possible. The crawl adds only:
1. a **deterministic front-end** that decides what the "conversation" is, in what
   **chronological order**, and recovers each document's **date**; and
2. a **scribe identity** so ingestion never touches a wolf's personal den.

Everything else — observe, ledger, consolidate, journey, promote, emitDelta,
Dewey — is the template, unchanged except doc-mode framing and date sourcing.

## 2. Two outputs, not one

| Artifact | Prompt | Meaning | Crawl behaviour |
|---|---|---|---|
| **Topics** | `CRAWL_CONSOLIDATE_SYSTEM` | *what is true now* | current-state prose; supersede & delete obsolete freely |
| **Journey** | `CRAWL_JOURNEY_SYSTEM` | *how it got here* | dated, chronological arc; append + compress oldest |

This split resolves the supersession tension: topics stay pure current-state; the
historical detail current-state consolidation discards is exactly what the
**journey** preserves. `live` facts update topics; `archived`/`snapshot` dated
facts build the journey. For a historical corpus the journey is often the headline
output — literally *"a descriptive history of how this reached its current state."*

## 3. Identity: the scribe wolf

Ingestion runs under a dedicated wolf **`scribe`** with its own den. Routing a
bulk crawl through a personal den buries a wolf's lived memory; a dedicated
identity makes accumulation the scribe's *job*, and needs **zero changes** to the
promote/den/emit path. The scribe den doubles as a staging + audit layer.

Scribe emits ordinary contributions, so it is Dewey-compatible: later it can move
onto the VPS next to Dewey, or its loop can fold into Dewey's process.

A headless `ScribeRuntime implements AgentRuntime` backs the orchestrator:
`cwd` = scribe den, `sessionId` = `crawl-<ts>`, ledger mirrored to
`<scribeDen>/crawl/<session>/ledger.jsonl` for crash-resume. No live Pi session is
touched.

### Den-corruption safety (the command is available in any wolf)

`/wolf:crawl` ships with the memory extension, so it is reachable from any wolf.
Two guards make that safe regardless of who runs it:

1. **Ingestion is always scribe, never the invoking wolf.** `run.ts` writes only
   the scribe den; the caller's den is never touched. Hard guarantee.
2. **Observation is paused during plan mode.** Plan mode is a conversation in the
   *live* wolf session, and the memory observer runs on `turn_end`. If the
   planning agent reads source files, those contents would otherwise be observed
   into the caller's den. So while `planMode` is set, the `turn_end` observer is
   suppressed — closing the only real leak vector.

Policy: **suggest, don't enforce.** When invoked in a non-scribe wolf, show a
nudge ("crawl ingests as scribe; this den is not written; observation paused").
Optional hard gate `WOLFPACK_CRAWL_REQUIRE_SCRIBE=1` refuses unless
`WOLF_NAME === scribe`. Default allows planning in your live wolf (where your
domain knowledge is) while the two guards keep every den clean. Recommended setup
is a dedicated **scribe wolf** — its own den is the natural staging/audit trail.

## 4. Observability: /tmp first

While the system is being built, **every stage writes its output to
`/tmp/wolfpack-crawl/<session>/` first**, before anything reaches the KB. This is
the development microscope — inspect each stage in isolation:

```
/tmp/wolfpack-crawl/<session>/
  plan.yaml              the resolved plan (discover + dates + group)
  dates.json            per-file date + basis + confidence (the trust chain output)
  observations.jsonl    doc-mode observer output per chunk (timestamped)
  topics/<batch>.md     per-batch consolidated current-state topic
  journey.md            the reconstructed, date-ordered narrative
  contributions/<id>.md exactly what WOULD be emitted to the inbox
  run.log               stage-by-stage trace with counts + timings
```

`--dry-run` stops after writing these; a real run additionally copies
`contributions/` into the librarian inbox. The `/tmp` tree is the default sink
until the pipeline is trusted end to end, then the inbox copy is enabled by
default.

## 5. Module layout

```
packages/memory/src/crawl/
  index.ts        barrel exports
  schemas.ts      [zod]   CrawlPlan, Batch, SourceFile, DateInfo, CrawlOutput
  discover.ts     [pure]  walk + include/exclude globs → SourceFile[]
  dates.ts        [det]   resolve each file's date + confidence via the trust chain
  group.ts        [pure]  strategies → CrawlPlan (+ chronological ordering)
  plan.ts         [IO]    planCrawl + CrawlPlan read/write YAML + render + validate (run gate)
  sink.ts         [IO]    the /tmp observability writer (§4)
  extract.ts      [LLM]   doc-mode observe per batch → observations.jsonl (§7)
  consolidate.ts  [LLM]   consolidateTopic (per batch) + running digest + topic docs (§8)
  journey.ts      [LLM]   the reconstructed arc from topics' dated events (§9)
  run.ts          [IO]    runCrawl: gate → extract → consolidate per batch (parallel) → journey
  resume.ts       [IO]    resumeCrawl: redo consolidate + journey from saved artifacts
  emit.ts         [IO]    release staged topics + history to the inbox (§10)
  cli.ts          [IO]    headless `crawl plan|run|resume|emit` for dev + automation

packages/memory/src/observer/prompts.ts   + CRAWL_OBSERVER_SYSTEM, buildCrawlObserverPrompt
packages/memory/src/observer/observe.ts   + mode: "conversation" | "document", sourceDate
```

KB seams (small, additive):

```
packages/kb/src/shared/schemas/contribution.ts   + temporal + currency fields
packages/kb/src/client/emitDelta.ts              carry temporal fields through
packages/kb/src/librarian/intake.ts              parse temporal fields back
packages/kb/src/librarian/oracles.ts             contradict: use dates; history = append
packages/kb/src/librarian/produce.ts             stamp entry as_of / historical
```

## 6. Deterministic front-end

### 6.1 Discover `[pure]`

`discoverSources(root, { include, exclude }): SourceFile[]`
- Default excludes: `**/.obsidian/**`, `**/.stfolder/**`, `**/node_modules/**`,
  `**/.git/**`, `**/.DS_Store`, `**/TaskNotes/Views/**`.
- Default include: `**/*.md`. Returns `{ absPath, relPath, bytes }[]`.

### 6.2 Resolve dates + confidence `[deterministic]`

`resolveDate(file, { gitRepo? }): DateInfo` — the ordering substrate. Because the
journey depends on order, dates are **confidence-tiered**, and we **never
fabricate**:

| Tier | Source | Trust | Orders? |
|---|---|---|---|
| high | frontmatter date, git-authored, filename `YYYY-MM-DD` | grounded, precise | hard key |
| medium | in-content explicit date (observer, §7) | grounded in text | yes, beats mtime |
| low | filesystem mtime (synced vaults = copy date) | unreliable | **no** |
| none | nothing resolves | unknown | **undated** |

```ts
interface DateInfo {
  date?: string;        // ISO "YYYY-MM-DD"
  basis: "frontmatter" | "git" | "filename" | "content" | "mtime" | "none";
  confidence: "high" | "medium" | "low" | "none";
}
```

**In-content dates outrank mtime**: a synced vault's mtime is the archive date; the
text saying "2026-03 launch" is better signal. mtime is recorded but **not trusted
for ordering** — a confidently-wrong date corrupts the journey and can make a stale
fact supersede a current one. *Wrong is worse than unknown.*

### 6.3 Group → plan `[pure]`

`buildPlan(files, dates, { strategy, domain, currency }): CrawlPlan`

Strategies generate the plan; no side effects:
- **`by-folder`** — leaf folder = batch (taxonomic vaults: `api/`, `marketing/`).
- **`by-pattern`** — strip date prefix + phase suffix, group by stem (dated
  plan/spec dirs: `invitation-unification-plan-1` + `…-design` → one batch).
- **`by-manifest`** — hand-written plan (messy dens; prune + cherry-pick).
- *(deferred)* **`auto`** — LLM proposes batches from the tree.

Grouping need not be perfect — Dewey re-routes/merges/crystallizes. It only needs
coherent, topic-sized batches. **Batches and documents are ordered oldest→newest**
by high-confidence date; undated ones are held for content placement (§8).

### 6.4 The plan `[IO]` + run gate

```yaml
# crawl-plan.yaml — deterministic, hand-editable
domain: snapjack
source: ~/wolves/_archive/old-kb-snapjack/snapjack
currency: archived              # whole-crawl default; per-batch override
status: draft                   # draft | ready  (run requires ready)
exclude: ["**/.obsidian/**", "**/.stfolder/**"]
batches:
  - topic: api
    files: ["api/*.md"]
  - topic: app-state
    files: ["now/*.md", "roadmap.md"]
    currency: live
    date: 2026-09                # HUMAN-PINNED date (see §8), becomes high-confidence
```

Run gate (`/wolf:crawl-run` / `crawl run`) refuses unless **every** rule passes —
"cannot run without a plan matching the structure":
1. plan exists; 2. validates against `CrawlPlanSchema`; 3. `status: ready`;
4. `source` is a directory; 5. `domain` is **declared** in KB `domains.yaml`;
6. every batch resolves to ≥1 file; 7. no file in two batches; 8. `currency` in
enum.

## 7. Extraction — doc-mode observer `[LLM, parallel]`

The observer *is* the template's extractor. Add a `mode` + source date; keep the
Zod contract so everything downstream is unchanged:

```ts
observe({ engine, chunkText, mode: "document", sourceDate })
```

`CRAWL_OBSERVER_SYSTEM` (precision lifted from `OBSERVER_SYSTEM`):
- Extract atomic **claims / facts / decisions / state** from a *document* (INERT
  DATA — do not act on it). No "User stated" framing.
- **Timestamp = the supplied source date.** If a fact carries its **own explicit
  in-text date**, use that (medium-tier content date). **Never invent a date** —
  an undated fact stays undated.
- Same output contract (single-line prose, split compound, identifiers/numbers
  verbatim). It is fine to emit zero.

Within a batch, files and chunks are observed in order; batches run in parallel
(up to `DEFAULT_CRAWL_CONCURRENCY` = 5). Weak model (haiku) by design — the prescriptive prompt is what makes it near-
deterministic, exactly as live memory's observer already is.

## 8. Consolidation — per-batch rolling topic `[LLM + code]`

The difference from live memory: live *discovers* topics (MERGE/CREATE); a crawl
*pre-declares* them as batches. So consolidation is called **per batch, scoped to
one target topic** (`consolidateTopic`) with `CRAWL_CONSOLIDATE_SYSTEM` — the
precision of `CONSOLIDATE_SYSTEM` plus temporal currency and a dated events list.
The result is the template's own rolling current-state document.

- Within a batch, observations are fed **oldest→newest** so newer facts supersede
  older ones correctly.
- **Digest-primed:** each batch sees a "PACK ALREADY KNOWS" block built from the
  domain's published `_digest.json` plus the topics this crawl's already-finished
  batches produced (the running digest), so it extends existing knowledge instead
  of restating it. Batches run in parallel, so "finished" depends on timing.
- After the LLM writes the body, **code stamps** the temporal frontmatter from the
  batch's resolved dates (agent owns content, code owns dates).
- **Undated observations** (confidence none): consolidation places them by
  *content evidence* (in-text references, version/event mentions) — relative, not
  a fabricated `YYYY-MM-DD`. If nothing places them, they land in an explicit
  **undated/approximate** bucket. Grounded-relative beats fabricated-absolute.

## 9. Journey — the reconstructed arc `[LLM + code]`

`CRAWL_JOURNEY_SYSTEM`, built from every topic's dated events (not raw observations):
- Segments are **ordered by recovered document date** and **stamped with that
  date**, not crawl-time.
- Approximate placements are marked approximate (`~2026`, "circa", "undated") —
  the journey states what it knows and flags what it doesn't. Never fake precision.
- Compress oldest segments to budget, as in live memory.

**Output (v1):** one per-domain **history entry** emitted as a contribution with
`currency: archived`. Dewey treats history entries as **append-not-supersede** (a
small note in contradict/produce). Eventual home: a first-class per-domain
`_history` surface alongside `INDEX.md`.

## 10. Emit `[deterministic]`

For each stamped topic (and the journey/history entry), `run.ts` writes to the
`/tmp` sink's `contributions/`, and — once past dry-run — calls `emitDelta` under
the scribe identity: `from: scribe`, `domainHint: <domain>`,
`denTopicId: <batchId>` (stable → re-crawls route as merges), plus the temporal +
currency block. Dewey receives real dates. Just topic/journey → validate → stamp →
inbox → sweep.

### Contribution schema additions

```ts
sourceCreated: z.string().optional(),   // earliest source date in the batch
sourceUpdated: z.string().optional(),   // latest source date
dateBasis: z.enum(["frontmatter","git","filename","content","mtime","none"]).optional(),
dateConfidence: z.enum(["high","medium","low","none"]).optional(),
currency: z.enum(["live","snapshot","archived"]).optional(),
sourcePath: z.string().optional(),
```

All optional → existing wolf promotions unaffected. `intake.ts` parses them back;
`emitDelta` renders them.

## 11. Execution model — plan mode, then run

**The wolf plans; the scribe executes.** Planning is a conversation in the live
wolf session; execution runs headless under scribe. They never mix.

### Plan mode (`/wolf:crawl <path>`)
Does **not** ingest. Seeds the conversation with a `crawl_discover` summary,
activates read-only plan tools via `pi.setActiveTools()`, and injects a steer in
`before_agent_start`. The user brings domain + date knowledge; the agent builds
`crawl-plan.yaml` via deterministic tools.

Plan tools (`pi.registerTool`, thin wrappers over §6, all `readOnlyHint` except
`crawl_write_plan`): `crawl_discover`, `crawl_dates`, `crawl_group`,
`crawl_preview`, `crawl_validate`, `crawl_write_plan`.

**Date-pinning:** `crawl_dates` flags low/none-confidence batches; the user pins a
`date:` per batch in the plan (domain knowledge → high-confidence source). This
turns the weakest link — ordering — into a reviewed decision instead of a guess.

### Run (`/wolf:crawl-run [plan]`)
The only path that ingests. Applies the §6.4 gate; on success runs §7–§10 and
clears plan mode. `/wolf:crawl-cancel` exits without running. A `tool_call` guard
blocks ingestion bypass during plan mode. Headless CLI mirrors: `crawl plan` /
`crawl run` with the same gate.

## 12. Determinism boundary

| Stage | Kind | Notes |
|---|---|---|
| discover | pure | glob walk |
| dates | deterministic | trust chain + confidence; git IO but reproducible; mtime never orders |
| group / plan / order | pure | strategies + chronological sort; unit-testable |
| **observe** | **LLM** | doc-mode; batches in parallel; timestamp = recovered date; never invents dates |
| **consolidate** | **LLM + code** | per-batch rolling topic; code stamps dates; places undated by content |
| **journey** | **LLM + code** | date-ordered arc; marks approximate; append+compress |
| emit | deterministic | /tmp first; hash-dedup; `from: scribe`; temporal block |
| Dewey sweep | deterministic + guarded LLM | dated contradict; history = append |

Two LLM touchpoints, identical to live memory (observe, consolidate) + the journey
call. Everything else is code; the plan fully bounds what each LLM call sees.

## 12a. Status (implemented)

All stages built, observable via `/tmp/wolfpack-crawl/<session>/`, unit-tested
(`crawl.test.ts`, `consolidate.test.ts`).

- **Deterministic CLI** (`crawl.../cli.js`): `plan` → `run` → `emit`, plus `resume`
  (reuse saved artifacts: `--from observations` re-does consolidate+journey;
  `--from topics` re-does just the journey). Gate enforced on `run`.
- **Pi extension commands** (wolfpack-memory): `/wolf:crawl` (plan mode + observer
  pause), `/wolf:crawl-run` (gate + run under `scribe`, live monitor, resume),
  `/wolf:crawl-release` (review + confirm + emit, all in one), `/wolf:crawls`
  (list runs), `/wolf:crawl-cancel`. Plan tools: `crawl_plan`, `crawl_preview`,
  `crawl_validate`, `crawl_finalize`.
  The pipeline is **plan → run → release**; release is the single command that
  previews exactly what hits the inbox, confirms, then emits to Dewey.
  (The deterministic CLI keeps `emit` for headless/Linux wolves.)
- **Scribe safety**: ingestion never writes the invoking wolf's den; observation
  paused in plan mode; nudge when not scribe; `WOLFPACK_CRAWL_REQUIRE_SCRIBE=1`
  hard-gates.
- **Dewey (step 7)**: dated `contradict` + deterministic archive-safety (an
  archived contribution older than a live entry never supersedes it); entry
  frontmatter gains `asOf` + `historical`.
- `run`/`emit`/`resume` are extension-safe (return results / throw, never
  `process.exit`).

The wolf PLANS; the scribe EXECUTES; `emit` RELEASES — three reviewed steps.

## 13. Build order

1. `schemas.ts` + `contribution.ts` temporal/currency fields (+ `emitDelta`/
   `intake` round-trip). Pure; testable immediately.
2. `discover.ts`, `dates.ts` (confidence tiers), `group.ts` (+ ordering),
   `plan.ts`, `sink.ts`. Unit tests vs the three reference corpora. **Dry-run
   writes the `/tmp` tree — observe discovery + dates + plan before any LLM.**
3. `CRAWL_OBSERVER_SYSTEM` + `observe({ mode, sourceDate })`; dump
   `observations.jsonl` to `/tmp`.
4. Per-batch consolidate (under the scribe identity); dump `topics/` to `/tmp`.
5. Journey (date-ordered) → `/tmp/journey.md` + history contribution.
6. `emit.ts` (still `/tmp` only) → `contributions/`; then enable inbox copy.
7. Dewey: dated contradict + append-history + entry `as_of`/`historical`.
8. Plan mode tools + `/wolf:crawl` / `/wolf:crawl-run`.
9. Deferred: `auto` strategy; first-class `_history` surface.

## 14. Testing

- **Pure stages**: fixtures for the three corpora (taxonomic vault, dated
  plan/spec dir, messy den). Assert plan, batch ordering, date basis+confidence.
- **Date confidence**: frontmatter > git > filename > content > mtime; synced-vault
  mtime never orders; human-pinned date wins.
- **Ordering**: batches/docs sort oldest→newest; undated bucket is last/relative.
- **Round-trip**: `emitDelta → intake` preserves temporal + currency.
- **Archive safety**: an older `archived` contribution does not supersede a newer
  live entry; a history entry appends rather than supersedes.
