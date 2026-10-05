# Knowledge Management

Two systems. Wolf memory is personal. Pack knowledge is shared.

---

## Two Systems

```
┌──────────────────────────────┐     ┌──────────────────────────────┐
│  WOLF MEMORY (per wolf)      │     │  PACK KNOWLEDGE (shared)     │
│                              │     │                              │
│  What happened to ME         │     │  What the PACK knows         │
│  My sessions, my tasks       │     │  Curated facts, decisions    │
│  My working context          │     │  Queryable by any wolf       │
│                              │     │                              │
│  Lives in: dens/{wolf}/      │     │  Lives in: knowledge/        │
│  Owned by: the wolf          │     │  Owned by: the Librarian     │
│  Scope: private              │     │  Scope: domain-gated         │
└──────────────────────────────┘     └──────────────────────────────┘
         │                                       │
         │              ┌────────┐               │
         └─────────────►│  WOLF  │◄──────────────┘
                        └────────┘
                  Wolf has both:
                  - Its own memory
                  - Access to scoped pack knowledge
```

---

## Wolf Memory

Personal, persistent, private to the wolf.

**What goes here:**
- Session history / conversation context
- Task state and progress
- Working notes
- Learned preferences about its user
- Compacted memory from past sessions

**Location:** `dens/{wolf}/`

**Owned by:** The wolf itself. No other wolf reads or writes here.

**Lifecycle:** Created when wolf is provisioned. Grows over time. Can be reset.

---

## Pack Knowledge

Shared, curated, domain-scoped.

**What goes here:**
- Verified facts
- Recorded decisions
- Processes and procedures
- Reference documents

**Location:** `knowledge/`

**Owned by:** The Librarian. Wolves read. Wolves contribute claims. Only the Librarian writes entries.

---

## Domain Scoping

Wolves don't get the whole KB. They get the **domains they're configured for**.

```yaml
# wolves/hal.yml
knowledge:
  domains:
    - personal      # Full access
    - wolfpack      # Full access
    - snapjack      # Read-only

# wolves/snapjack-bi.yml
knowledge:
  domains:
    - snapjack      # Full access

# wolves/forge.yml
knowledge:
  domains:
    - wolfpack      # Full access
```

### What domain access means

| Access | Read KB | Submit claims | Loaded into context |
|--------|---------|---------------|---------------------|
| Full   | ✅      | ✅            | ✅                  |
| Read-only | ✅   | ❌            | ✅                  |
| None   | ❌      | ❌            | ❌                  |

### How it works at runtime

```
Wolf starts up
     │
     ├── Load wolf memory from den
     │
     ├── Check domain config
     │     └── domains: [snapjack, wolfpack]
     │
     ├── Load KB indexes for those domains
     │     ├── knowledge/domains/snapjack/INDEX.md
     │     └── knowledge/domains/wolfpack/INDEX.md
     │
     └── During work: query only scoped domains
```

A wolf configured for `[snapjack]` literally cannot see `personal` or `wolfpack` entries. It doesn't know they exist.

---

## The Full Loop

```
1. Wolf works on a task
        │
        ├── Reads from its own memory (den)
        ├── Queries pack knowledge (scoped domains)
        │
2. Wolf learns something
        │
        ├── Updates its own memory (den)
        └── Submits claim to Librarian (if pack-worthy)
                │
3. Librarian curates
        │
        ├── Creates/merges/rejects
        └── Entry lands in KB under a domain
                │
4. All wolves scoped to that domain can now access it
        │
5. New wolf spins up with those domains → has the knowledge
```

---

## New Wolf Onboarding

```yaml
# wolves/new-wolf.yml
name: new-wolf
role: "Research assistant"

knowledge:
  domains:
    - snapjack
    - wolfpack
```

**What happens:**
1. Wolf gets an empty den (no personal memory yet)
2. Wolf gets full access to `snapjack` and `wolfpack` KB domains
3. Wolf is immediately as informed as any other wolf on those domains
4. Wolf starts building its own memory through sessions

**Personal memory:** Starts empty, grows.  
**Pack knowledge:** Full from day one (within scoped domains).

---

## Open Design Questions

1. **Domain access levels** — Is full/read-only/none enough, or do we need finer grain?
2. **Context loading strategy** — Load full domain index? Relevant entries only? Embeddings?
3. **Memory format** — What structure inside a den?
4. **Memory ↔ Knowledge boundary** — When does wolf memory become a claim worth submitting?
5. **Librarian architecture** — File-based curation vs. agent pipeline?
6. **Query interface** — How does a wolf actually query the KB at runtime?
