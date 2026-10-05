# Wolfpack

A framework for running personalized AI agents with persistent, shared knowledge.

## Architecture

```
PI Session → OM Observer → Session Memory
                                ↓
                    Wolf Consolidator → Den Memory
                                ↓
                    Auto-claim → Librarian Inbox
                                ↓
                    Librarian Engine → Knowledge Base
                                ↓
                    All scoped wolves → Full context
```

## Packages

| Package | Description | Status |
|---|---|---|
| `@wolfpack/engine` | Schemas, pipeline, adapter interface | 🟢 Building |
| `@wolfpack/librarian` | Librarian agent — claim processing pipeline | 🔲 Next |
| `@wolfpack/cli` | Pack management CLI | 🔲 Planned |

## Project Layout

```
packages/
  engine/          # Core: schemas, search, parse, commit, index generation
  librarian/       # Librarian: claim assessment + entry curation
  cli/             # Pack management commands

infra/             # Ansible roles, playbooks, inventory (reference)
legacy/            # Old CLI, core, cc-bot (reference)
docs/planning/     # Architecture docs and design notes
```

## Development

```bash
npm install
npm run typecheck
npm test
```
