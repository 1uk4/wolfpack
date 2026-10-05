# Knowledge Engine

The Librarian's brain. Takes raw claims in, produces curated knowledge out.

---

## Principle: Own the Interface

```
┌──────────────────────────────────────────────┐
│  OUR INTERFACE (we own this)                 │
│                                              │
│  Pipeline steps, schemas, contracts          │
│  Written in Zod + TypeScript                 │
│                                              │
├──────────────────────────────────────────────┤
│  ADAPTER (swappable)                         │
│                                              │
│  Today: Anthropic API + Zod validation       │
│  Tomorrow: TypeSafe.ai, Instructor, Mastra,  │
│            or whatever wins                  │
│                                              │
├──────────────────────────────────────────────┤
│  PROVIDER (swappable)                        │
│                                              │
│  Anthropic, OpenAI, local model, etc.        │
│                                              │
└──────────────────────────────────────────────┘
```

We define the pipeline. We define the schemas. The thing that calls the LLM is a pluggable adapter. If TypeSafe.ai is great, use it. If something open-source appears, swap the adapter. Our pipeline doesn't change.

---

## Pipeline

Five steps. Each step has a typed input and typed output.

```
  Claim file
      │
      ▼
┌─────────────┐
│  1. PARSE   │  Extract structured claim from markdown
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  2. SEARCH  │  Find related existing entries
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  3. ASSESS  │  LLM decides: create / merge / supersede / reject
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  4. PRODUCE │  LLM generates the curated entry
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  5. COMMIT  │  Write entry, receipt, update index
└─────────────┘
```

### Step 1: PARSE (no LLM needed)

Read the claim file, validate format, extract fields.

```typescript
// Input
interface RawClaim {
  filePath: string
  content: string
}

// Output
interface ParsedClaim {
  from: string
  domain: string
  submitted: string
  title: string
  claim: string
  evidence: string
  sources: string[]
  context?: string
}
```

Pure code. Parse markdown frontmatter + sections. Reject malformed claims early.

### Step 2: SEARCH (no LLM needed)

Find existing KB entries that might be related.

```typescript
// Input
interface SearchInput {
  claim: ParsedClaim
  domain: string
}

// Output
interface SearchResult {
  related: KBEntry[]       // Entries that might overlap
  duplicates: KBEntry[]    // Entries that say the same thing
  contradictions: KBEntry[] // Entries that conflict
}
```

Start simple: keyword search against titles and summaries in the domain. Upgrade to embeddings later if needed.

### Step 3: ASSESS (LLM — this is the judgment call)

Given the claim and related entries, decide what to do.

```typescript
// Input: ParsedClaim + SearchResult

// Output
interface Assessment {
  action: 'create' | 'merge' | 'supersede' | 'reject'
  reasoning: string
  confidence: 'low' | 'medium' | 'high' | 'verified'
  type: string           // fact, decision, process, reference, bug, etc.
  subcategory: string
  mergeTarget?: string   // KB entry ID (if action is merge)
  supersedeTarget?: string // KB entry ID (if action is supersede)
  rejectReason?: string  // (if action is reject)
}
```

**This is the core LLM call.** It gets the claim, the related entries, and the curation rules. It returns a structured decision.

### Step 4: PRODUCE (LLM — generates the entry)

Given the claim and the assessment, produce the curated KB entry.

```typescript
// Input: ParsedClaim + Assessment + existing entry (if merge/supersede)

// Output
interface ProducedEntry {
  id: string
  title: string
  type: string
  domain: string
  subcategory: string
  confidence: string
  summary: string
  detail: string
  context: string
  contradictions?: string
  sources: string[]
  expires: string
  supersedes: string[]
}
```

**Second LLM call.** Takes the raw claim and writes it as a proper KB entry following the schema.

### Step 5: COMMIT (no LLM needed)

Write everything to disk.

```typescript
// Actions:
// 1. Write entry markdown to knowledge/domains/{domain}/entries/
// 2. If superseding: update old entry status
// 3. Write receipt to librarian/receipts/{wolf}/
// 4. Move claim from inbox/ to processed/
// 5. Regenerate domain INDEX.md
```

Pure code. File I/O.

---

## The Adapter Interface

This is what we own. Any structured-output library implements this.

```typescript
interface KnowledgeAdapter {
  /**
   * Given a claim and related entries, assess what action to take.
   */
  assess(input: {
    claim: ParsedClaim
    related: KBEntry[]
    rules: CurationRules
  }): Promise<Assessment>

  /**
   * Given a claim and assessment, produce a curated KB entry.
   */
  produce(input: {
    claim: ParsedClaim
    assessment: Assessment
    existingEntry?: KBEntry  // if merge/supersede
    schema: EntrySchema
  }): Promise<ProducedEntry>
}
```

That's it. Two methods. Everything else is pure code around it.

---

## Adapter Implementations

### Today: Raw Anthropic API + Zod

```typescript
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'

class AnthropicAdapter implements KnowledgeAdapter {
  private client: Anthropic

  async assess(input): Promise<Assessment> {
    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-20250514',
      system: CURATION_PROMPT,
      messages: [
        { role: 'user', content: formatAssessmentPrompt(input) }
      ]
    })

    // Parse and validate with Zod
    return AssessmentSchema.parse(
      JSON.parse(extractJSON(response.content))
    )
  }

  async produce(input): Promise<ProducedEntry> {
    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-20250514',
      system: ENTRY_WRITER_PROMPT,
      messages: [
        { role: 'user', content: formatProducePrompt(input) }
      ]
    })

    return ProducedEntrySchema.parse(
      JSON.parse(extractJSON(response.content))
    )
  }
}
```

Zero dependencies beyond the Anthropic SDK and Zod. Works today.

### Tomorrow: TypeSafe.ai (if they open-source or we decide to use it)

```typescript
import { TypeSafe } from '@typesafe/ai'

class TypeSafeAdapter implements KnowledgeAdapter {
  async assess(input): Promise<Assessment> {
    return TypeSafe.extract(AssessmentSchema, {
      prompt: formatAssessmentPrompt(input),
      model: 'claude-sonnet-4-20250514'
    })
  }

  async produce(input): Promise<ProducedEntry> {
    return TypeSafe.extract(ProducedEntrySchema, {
      prompt: formatProducePrompt(input),
      model: 'claude-sonnet-4-20250514'
    })
  }
}
```

Same interface. Swap the import. Pipeline doesn't change.

### Future: Open-source alternative (Instructor, Mastra, etc.)

```typescript
class InstructorAdapter implements KnowledgeAdapter {
  // Same interface, different implementation
}
```

---

## Zod Schemas (we own these regardless of adapter)

```typescript
import { z } from 'zod'

const AssessmentSchema = z.object({
  action: z.enum(['create', 'merge', 'supersede', 'reject']),
  reasoning: z.string(),
  confidence: z.enum(['low', 'medium', 'high', 'verified']),
  type: z.string(),
  subcategory: z.string(),
  mergeTarget: z.string().optional(),
  supersedeTarget: z.string().optional(),
  rejectReason: z.string().optional()
})

const ProducedEntrySchema = z.object({
  title: z.string(),
  type: z.string(),
  domain: z.string(),
  subcategory: z.string(),
  confidence: z.enum(['low', 'medium', 'high', 'verified']),
  summary: z.string(),
  detail: z.string(),
  context: z.string(),
  contradictions: z.string().optional(),
  sources: z.array(z.string()),
  expires: z.string(),
  supersedes: z.array(z.string())
})
```

These schemas are ours. They define the contract. The adapter just fills them.

---

## Curation Rules (configurable)

```typescript
interface CurationRules {
  // What to accept
  minEvidenceRequired: boolean
  requireSources: boolean
  allowLowConfidence: boolean

  // How to assess
  duplicateThreshold: number      // How similar before it's a duplicate
  mergePreference: boolean        // Prefer merging over creating

  // Domain rules
  domainSpecificRules: Record<string, {
    allowedTypes: string[]
    requireExpiry: boolean
    defaultExpiry: string
  }>
}
```

Configurable per pack. Defaults are sane. Power users can tune.

---

## What We Actually Build

```
packages/
└── librarian/
    ├── src/
    │   ├── pipeline/
    │   │   ├── parse.ts       # Step 1: Parse claim file
    │   │   ├── search.ts      # Step 2: Find related entries
    │   │   ├── assess.ts      # Step 3: Wrap adapter.assess()
    │   │   ├── produce.ts     # Step 4: Wrap adapter.produce()
    │   │   ├── commit.ts      # Step 5: Write files
    │   │   └── index.ts       # Run full pipeline
    │   │
    │   ├── adapters/
    │   │   ├── interface.ts   # KnowledgeAdapter interface
    │   │   ├── anthropic.ts   # Anthropic + Zod adapter
    │   │   └── index.ts       # Adapter registry
    │   │
    │   ├── schemas/
    │   │   ├── claim.ts       # ParsedClaim schema
    │   │   ├── assessment.ts  # Assessment schema
    │   │   ├── entry.ts       # ProducedEntry schema
    │   │   └── index.ts
    │   │
    │   ├── kb/
    │   │   ├── reader.ts      # Read KB entries
    │   │   ├── writer.ts      # Write KB entries
    │   │   ├── indexer.ts     # Generate domain indexes
    │   │   └── query.ts       # Query KB
    │   │
    │   └── index.ts           # Public API
    │
    ├── prompts/
    │   ├── assess.md          # Assessment system prompt
    │   └── produce.md         # Entry writer system prompt
    │
    └── package.json
```

---

## Dependencies

### Hard dependencies (unavoidable)
- `zod` — Schema validation (MIT, ~50KB, zero deps)
- An LLM SDK — Anthropic, OpenAI, or whatever provider

### No dependency on
- TypeSafe.ai — Can use it, don't need it
- LangChain — Too heavy
- Vector databases — Start with keyword search
- External services — Everything runs locally

---

## Summary

**What we own:** Pipeline steps, Zod schemas, curation rules  
**What's swappable:** The adapter (how we call the LLM and validate output)  
**What's configurable:** Curation rules, domains, provider

The adapter interface is two methods: `assess()` and `produce()`. Everything else is our code. If TypeSafe.ai open-sources, drop in a new adapter. If something better appears, same thing. The pipeline doesn't care.
