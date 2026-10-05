# Wolfpack Library — Canonical Knowledge Spec (v0.1)

> **Status:** draft spec. This is the first job of the builder (PI) wolf:
> formalize this format, seed the canonical store from existing knowledge, and
> stand up the read + propose flows described here.
>
> **Scope of v0.1:** the *canonical shared view* — one true, current picture of
> shared domain knowledge that every wolf can read. Access gating, Jev-based
> classification, and inter-wolf messaging are **out of scope** here but the
> format is designed so they slot in later without migration.

---

## 1. Purpose

The Library is the pack's **single source of truth** for shared domain
knowledge (e.g. the Snapjack app: its systems, data models, APIs, roadmap).
Multiple wolves depend on it (Hal understands structure; snapjack-bi understands
the app), so the Library exists to keep their shared understanding **consistent
and current** instead of drifting into per-wolf copies.

The Librarian's job is **not to store knowledge — it's to keep it true.**
Storage is trivial. Freshness, provenance, and single-writer reconciliation are
the product.

## 2. Core principles

1. **Single writer.** Only the Librarian writes canonical items. Wolves *read*
   freely and *propose* changes. No wolf edits canon directly. This prevents
   merge chaos and gives one audit/quality point.
2. **Freshness over completeness.** A stale-but-confident fact is worse than a
   gap. Every item carries provenance and a verification date; readers can see
   how much to trust it.
3. **Grounded vs interpretive.** Facts derivable from real artifacts (schema,
   routes, code) should be *generated/verified from them*, not hand-written
   prose that rots. Prose is reserved for intent, rationale, and plans.
4. **Default-visible now, gateable later.** Every item has a `visibility` field
   defaulting to `pack`. Gating is a future read-time filter on this field, not
   a schema change.
5. **Human-inspectable.** Markdown + YAML frontmatter, Obsidian-compatible, same
   as the dens. You can eyeball the pack's shared brain and roll back a bad
   update.

## 3. Item types

| Type | Meaning | Source of truth | Examples |
|------|---------|-----------------|----------|
| `grounded` | A fact derivable from a real artifact | The artifact (schema, code, route table) — regenerated/verified, never free-authored | data models, API endpoints, env config, table lists |
| `interpretive` | Judgment, intent, rationale, plans | Curated prose with provenance | why a decision was made, business logic intent, roadmap, competitive analysis |

**Rule:** an `interpretive` item must not assert a `grounded` fact as if
authoritative — link to the grounded item instead. Keep the two honest.

## 4. Store layout

Mirrors the existing `knowledge/snapjack/` tree (which is the seed). One
top-level folder per **domain**, then per **system**, then facet subfolders.

```
library/
├── _meta/
│   ├── README.md              # what this store is, how to read/propose
│   ├── schema.md              # this spec, condensed for wolves
│   └── changelog.md           # append-only log of canonical changes
├── <domain>/                  # e.g. snapjack
│   ├── MOC.md                 # map of content / index for the domain
│   ├── roadmap.md
│   ├── systems/
│   │   └── <system>/          # e.g. auth, game-tracking, leagues
│   │       ├── overview.md    # interpretive: what/why
│   │       ├── models/        # grounded: data models
│   │       ├── api/           # grounded: endpoints
│   │       ├── logic/         # interpretive: business logic intent
│   │       └── ux/            # interpretive
│   ├── now/                   # current focus
│   ├── planned/
│   └── changelog/
```

- **Domain** = a coherent knowledge area (a product, a company function).
- **System** = a subsystem within a domain.
- **Facet** (`models`/`api`/`logic`/`ux`) = tends to sort grounded vs
  interpretive: `models`/`api` trend `grounded`; `logic`/`ux`/`overview` are
  `interpretive`.

## 5. Knowledge-item frontmatter schema

Every `.md` item begins with YAML frontmatter. Required fields must be present
and valid or the item fails validation.

```yaml
---
id: snapjack.auth.models.session          # stable unique id (dotted path)
title: "Auth — Session model"
type: grounded                            # grounded | interpretive
domain: snapjack
system: auth                              # optional for domain-level items
facet: models                             # models | api | logic | ux | overview | roadmap | other
status: current                           # current | draft | deprecated | superseded
visibility: pack                          # pack | group:<name> | owner:<wolf> | private:<wolf>
owner: forge                              # wolf responsible for curating this item
source:                                   # provenance — REQUIRED
  kind: artifact                          # artifact | observation | curated
  ref: "repos/snapjack/src/models/session.ts"   # path/URL/commit when kind=artifact
  commit: "a1b2c3d"                       # optional, for artifact grounding
last_verified: 2026-09-28                 # date the fact was last checked vs reality
confidence: high                          # high | medium | low
tags: [auth, session]
links:                                    # related item ids (not free text)
  - snapjack.auth.api.login
supersedes: []                            # ids this item replaces
---

# Auth — Session model

<body: markdown. For grounded items, keep prose minimal and point at the
artifact. For interpretive items, this is the curated explanation.>
```

### Field rules

- **`id`** — stable, unique, dotted (`domain.system.facet.name`). Never reuse or
  renumber; on replacement use `supersedes`.
- **`type`** — drives validation (see §9).
- **`visibility`** — defaults to `pack`. Reserved forms: `pack` (all wolves),
  `group:<name>`, `owner:<wolf>` (owning wolf + Librarian), `private:<wolf>`
  (should almost never be in the Library — prefer the den). Enforcement is
  future work; **set it correctly now** so gating is a flip, not a migration.
- **`source.kind`** —
  - `artifact`: grounded in a real file/route/schema (`ref` + optional
    `commit`). Verifiable and regenerable.
  - `observation`: derived from a wolf observing behavior (must reference the
    proposing wolf + date).
  - `curated`: human/agent judgment with no single artifact.
- **`last_verified`** — the date the claim was last confirmed true. Drives
  staleness (see §6).
- **`confidence`** — reader's trust hint; `low` means "treat as provisional."
- **`links` / `supersedes`** — item ids only, never free text, so the graph
  stays machine-navigable.

## 6. Freshness & staleness

- `last_verified` + a per-type **staleness window** classifies an item:
  - `grounded`: stale after **14 days** (code changes fast).
  - `interpretive`: stale after **90 days**.
- A reader (or the Librarian) computes: `fresh` / `aging` / `stale` from
  `today - last_verified`.
- Stale items are **not deleted** — they're flagged. The read layer surfaces the
  flag ("⚠ last verified 40d ago") so wolves discount them.
- Re-verification updates `last_verified` (and `commit` for grounded items).
  For grounded items this should be automatable by the builder wolf against the
  repo.

## 7. Read flow

How a wolf consumes the Library:

1. **Discovery:** start from the domain `MOC.md` (index) or search by `id`/tag.
2. **Physical access (current phase):** the Library is a **receive-only**
   Syncthing folder on every wolf (like `shared/`), so reads are just local
   file reads. Mounted at `~/workspace/library/`.
3. **Trust signals:** the wolf respects `status`, `confidence`, and computed
   freshness. It should prefer `current` + `fresh` + `high`, and explicitly note
   when it's relying on `aging`/`stale`/`low` info.
4. **Later:** the Librarian exposes a `library.query` tool (semantic/RAG search)
   so wolves ask questions instead of walking files. Same data, better access.
5. **Gating (future):** the read layer filters by `visibility` per requesting
   wolf. v0.1 assumes everything is `pack`.

## 8. Propose flow (single-writer reconciliation)

Wolves never write canon. They submit **observations/deltas**; the Librarian
reconciles.

1. A wolf writes a proposal file to a **proposals inbox** (current phase: a
   Syncthing folder the wolf can write and the Librarian reads,
   `~/workspace/library-proposals/`).
2. Proposal format:

```yaml
---
proposal_id: 2026-09-28T19-32-00Z.snapjack-bi.auth-session-ttl
proposing_wolf: snapjack-bi
target_id: snapjack.auth.models.session   # existing id, or "new"
kind: update                              # new | update | deprecate | verify
observed: 2026-09-28
confidence: medium
source:
  kind: observation
  ref: "observed login token TTL is now 30d in prod responses"
---

## Proposed change
<what changed, evidence, why it matters>
```

3. The **Librarian** reviews each proposal and decides:
   - **accept** → writes/updates the canonical item, bumps `last_verified`,
     appends to `_meta/changelog.md` with provenance.
   - **merge** → reconciles with an existing item.
   - **reject** → logs reason in the changelog; notifies the proposing wolf.
   - **needs-human** → escalates to 1uk4.
4. Accepted proposals are archived; the inbox stays small.

## 9. Validation rules (lintable)

An item is valid iff:

- Required frontmatter present: `id`, `title`, `type`, `domain`, `status`,
  `visibility`, `source`, `last_verified`, `confidence`.
- `id` is unique across the store and matches its file location by convention.
- `type` ∈ {grounded, interpretive}; `status` ∈ {current, draft, deprecated,
  superseded}; `confidence` ∈ {high, medium, low}.
- `visibility` matches an allowed form.
- If `type: grounded` → `source.kind` must be `artifact` **and** `source.ref`
  present. Grounded items may not be `source.kind: curated`.
- `last_verified` is a valid ISO date, not in the future.
- `links`/`supersedes` reference existing ids.
- No `interpretive` item asserts a grounded fact without a `links` reference to
  the grounded item.

The builder wolf should ship a `library-lint` script enforcing this; CI-style,
run before any canonical write.

## 10. Change audit

`_meta/changelog.md` is append-only. Every canonical write records:

```
## 2026-09-28T19:40Z — update snapjack.auth.models.session
- by: forge (Librarian)
- proposal: 2026-09-28T19-32-00Z.snapjack-bi.auth-session-ttl (accepted)
- change: session TTL 7d → 30d
- last_verified: 2026-09-28, confidence: medium
```

This is the rollback + "what did the shared brain learn" record. Reuse the
existing `changelog/` convention.

## 11. Physical / sync layout (current phase, pre-dedicated-Librarian)

Until the Librarian is its own host, the builder wolf (`forge`) acts as
Librarian. Reuse the Syncthing hub-and-spoke pattern:

| Folder | On forge (Librarian) | On other wolves | Purpose |
|--------|----------------------|-----------------|---------|
| `library/` | send-receive (writer) | **receive-only** | canonical store |
| `library-proposals/` | receive (reads) | send-receive (write proposals) | inbox |

- Keep `library/` **out of the framework git repo** (it's living memory, not
  framework — same rule as dens/knowledge). Sync it, don't commit it.
- The seed content comes from the existing `knowledge/snapjack/` tree.

## 12. Out of scope for v0.1 (designed-for, not built)

- **Access gating enforcement** — `visibility` is recorded but not enforced yet.
- **Jev / model-based classification** — future, behind hard rules.
- **Inter-wolf messaging** — the proposals inbox is the only cross-wolf channel.
- **Semantic/RAG query tool** — v0.1 is file reads; `library.query` comes later.

## 13. First tasks for the builder (PI) wolf

Do these in order; each is shippable on its own:

1. **Formalize this spec** into `_meta/schema.md` (condensed for wolves) and
   `_meta/README.md`.
2. **Seed the canonical store** from `knowledge/snapjack/`: move items into the
   layout in §4, add frontmatter (§5), split grounded vs interpretive.
3. **Backfill provenance**: set `source`, `last_verified`, `confidence` on every
   seeded item. For grounded items, link to real artifacts in the snapjack repo.
4. **Write `library-lint`** (§9) and run it clean over the seed.
5. **Set up the read path**: `library/` as a receive-only Syncthing folder on the
   other wolves; update their den `AGENTS.md`/`CLAUDE.md` to read from
   `~/workspace/library/` and respect trust signals (§7).
6. **Set up the propose path**: `library-proposals/` inbox + a documented
   proposal template (§8); the Librarian review loop (start manual/agent-driven).
7. **Report** a summary of what was seeded, gaps, and stale items to 1uk4.

Everything after (gating, Jev, RAG query, dedicated Librarian host) is a
separate spec once v0.1 is real.
