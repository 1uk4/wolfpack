# Knowledge System — How It Actually Works

---

## Constraints We're Working With

- Wolves are LLM agent processes (Claude Code, Pi, etc.)
- They interact with the world via filesystem + tools
- Syncthing moves files between Mac and VPS
- We want this to work today, not in 6 months
- Lean — no infrastructure we don't need

---

## End-to-End Flow

### Step 1: Wolf Needs Context

Wolf starts a task. Needs to know things.

**What happens:**
```
Wolf reads its config → domains: [snapjack, wolfpack]
                            │
Wolf loads domain indexes    │
  knowledge/domains/snapjack/INDEX.md
  knowledge/domains/wolfpack/INDEX.md
                            │
Indexes tell the wolf what entries exist,
what they're about, and their trust level
                            │
Wolf pulls specific entries as needed
  knowledge/domains/snapjack/entries/kb-snapjack-XYZ.md
```

**The index is the key.** The wolf doesn't read 150 entries. It reads a compact index, understands what's available, and pulls entries relevant to its current task.

**What the index looks like:**
```markdown
## snapjack — 142 entries

### Product (24 entries)
- kb-snapjack-4w1ZptM — Leagues System (reference, curated, high)
- kb-snapjack-NyTsd18 — Two-mode poker app (fact, curated, high)
...

### Bugs (20 entries)
- kb-snapjack-42MYCtp — leagueHasFeature ignores frozen flag (bug, curated, high)
...
```

The wolf scans the index, sees what's relevant, reads those entries. Same as a human scanning a table of contents.

---

### Step 2: Wolf Learns Something

Wolf discovers a fact, makes a decision, finds a bug.

**What happens:**
```
Wolf writes a claim file
  → librarian/inbox/{wolf-name}/2026-10-03-my-discovery.md
```

**Claim format:**
```markdown
---
from: hal
domain: snapjack
submitted: 2026-10-03 14:30
---

# Paywall only gates league creation

## Claim
The paywall is active but only blocks creating new leagues.
All other features are free.

## Evidence
Read subscription-gate.ts at commit 22b1d06.

## Sources
- Commit 22b1d06
```

**That's it from the wolf's side.** Write a file, move on.

---

### Step 3: Librarian Processes the Claim

The Librarian is a wolf whose job is curation. It runs a pipeline:

```
Inbox scan
    │
    ▼
Read claim
    │
    ▼
Check existing KB
  "Is this already known?"
  "Does this contradict something?"
  "Does this update something?"
    │
    ▼
Decide action
  ├── CREATE — New entry
  ├── MERGE — Add to existing entry
  ├── SUPERSEDE — Replace old entry
  └── REJECT — Not useful (with reason)
    │
    ▼
Write result
  ├── New/updated entry → knowledge/domains/{domain}/entries/
  ├── Updated index → knowledge/domains/{domain}/INDEX.md
  └── Receipt → librarian/receipts/{wolf-name}/
```

**How the Librarian decides:** This is where it gets interesting. Two options:

**Option A: LLM-powered curation (lean start)**
The Librarian is an LLM agent. It reads the claim, reads relevant existing entries, and decides what to do. Its system prompt defines the curation rules. Output is structured (create/merge/supersede/reject + the entry content).

**Option B: Structured pipeline (TypeSafe.ai, later)**
Break curation into typed steps:
1. Classifier — what type of claim is this?
2. Deduplicator — does this already exist?
3. Curator — assess quality, evidence, confidence
4. Writer — produce the KB entry

Option A gets us running now. Option B is the upgrade path.

---

### Step 4: Knowledge Syncs to All Wolves

```
Librarian writes entry to knowledge/domains/snapjack/entries/
    │
    ▼
Syncthing syncs to Mac (if Librarian is on VPS)
    │
    ▼
Syncthing syncs from Mac to other VPS wolves
    │
    ▼
All wolves scoped to snapjack can now read it
```

No wolf needs to "refresh" or "restart." Next time a wolf reads the index or queries the KB, the new entry is there.

---

### Step 5: New Wolf Gets It All

```yaml
# wolves/new-analyst.yml
name: new-analyst
knowledge:
  domains: [snapjack]
```

```
New wolf starts
    │
    ▼
Reads knowledge/domains/snapjack/INDEX.md
    │
    ▼
142 entries available, all curated
    │
    ▼
Fully informed about Snapjack on first task
```

No migration. No data transfer. Just filesystem access to the same knowledge directory.

---

## The Pieces We Need to Build

### 1. Index Generator
Produces a compact, scannable index per domain from the entries.

**Input:** All entries in `knowledge/domains/{domain}/entries/`
**Output:** `knowledge/domains/{domain}/INDEX.md`

We already have this (`kb-index`). Needs to run after every Librarian write.

### 2. Claim Writer
Helps wolves write well-formed claims.

**Input:** Wolf's discovery (fact, evidence, sources)
**Output:** Claim file in `librarian/inbox/{wolf}/`

We already have this (`librarian.submitClaim()`). Needs to be available as a wolf tool/skill.

### 3. Librarian Agent
Processes claims into curated entries.

**Input:** Claim file + existing KB entries in that domain
**Output:** Curated entry + receipt

**This is the core thing to build.** Today it's manual. We need an LLM agent that:
- Reads a claim
- Searches existing KB for related entries
- Decides create/merge/supersede/reject
- Writes the entry in correct format
- Writes receipt
- Regenerates domain index

### 4. Domain Scoping Config
Tells each wolf which domains it can access.

**Input:** Wolf config YAML
**Output:** At runtime, wolf only reads/queries scoped domains

Simple — wolf config lists domains, tools/skills respect that list.

### 5. Query Tool
Lets wolves search the KB within their scoped domains.

**Input:** Query (search term, filters)
**Output:** Matching entries from scoped domains only

We already have this (`kb-query`). Needs domain scoping added.

---

## What Exists vs. What's Missing

| Piece | Status | Notes |
|-------|--------|-------|
| KB entries (markdown) | ✅ Exists | 152 entries across 3 domains |
| Index generator | ✅ Exists | `kb-index` script |
| Claim writer | ✅ Exists | `librarian.submitClaim()` |
| Query tool | ✅ Exists | `kb-query` script |
| Domain scoping | ❌ Missing | Wolf config + runtime enforcement |
| Librarian agent | ❌ Missing | The curation pipeline |
| Wolf memory format | ❌ Missing | What lives in a den |

---

## Build Order

```
Phase 1: Librarian Agent
  → Automate claim → curated entry pipeline
  → This is the engine that makes the whole system work

Phase 2: Domain Scoping
  → Wolf config defines domains
  → Query tools respect domain scope
  → Index loading respects domain scope

Phase 3: Wolf Memory Format
  → Define den structure
  → Define what's personal vs. what becomes a claim
  → Compaction rules

Phase 4: Context Loading Strategy
  → How much KB goes into a wolf's context window
  → Index-first, pull entries on demand
  → Summarization for large domains
```

---

## Decision: How Should the Librarian Work?

This is the most important decision. Three options:

### A. File-watching LLM agent (simplest)
```
Librarian = a wolf that watches inbox/
When new claim appears:
  1. Read claim
  2. Read existing entries in that domain
  3. LLM decides action
  4. Write entry + receipt
```
**Pro:** Works with what we have. Just a wolf with a specific job.
**Con:** LLM quality varies. No structured validation.

### B. Scripted pipeline + LLM assist
```
1. Script validates claim format
2. Script searches for duplicates
3. LLM assesses quality and decides action
4. Script writes entry in correct format
5. Script generates index
```
**Pro:** Consistent format. LLM only does the judgment call.
**Con:** More code to write.

### C. TypeSafe.ai structured pipeline (most robust)
```
1. Classify claim (typed output)
2. Search for related entries (structured query)
3. Assess claim (typed output: create/merge/supersede/reject)
4. Generate entry (typed output matching schema)
5. Write files
```
**Pro:** Type-safe, testable, reliable.
**Con:** More upfront work. Dependency on TypeSafe.ai.
