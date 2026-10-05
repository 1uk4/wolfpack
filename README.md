# Wolfpack

A framework for running personalized AI agents with persistent, shared knowledge.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Your Mac (host)                                            │
│                                                             │
│  wolfpack CLI ──────────────────────────────┐               │
│    • wolfpack add wolf <name>               │               │
│    • wolfpack list / status / logs          │               │
│    • wolfpack host add <vps> --ip <ip>      │               │
│                                             │  HTTP :3141   │
│  ~/wolves/                                  │  (Tailscale)  │
│    dens/1uk4/  (local wolf, Pi sessions)    │               │
│    knowledge/  (shared KB, synced)          │               │
│    librarian/  (claim inbox, synced)        │               │
│                                             ▼               │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  VPS (wolf-01)                                       │   │
│  │                                                      │   │
│  │  wolfpack-agent  ←── manages all wolves on this host │   │
│  │    │                                                 │   │
│  │    ├── /home/wolf-k7x2m/  (librarian)               │   │
│  │    ├── /home/wolf-m3p9q/  (hal)                      │   │
│  │    └── /home/wolf-r2d4w/  (forge)                    │   │
│  │                                                      │   │
│  │  Each wolf: own unix user, systemd service, Pi       │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Memory System

Three-tier memory with escalating curation:

```
Conversation → Observer → Observations → Consolidator → Session Topics
                                                          ↓ /wolf:promote
                                                    Den Topics (persistent)
                                                          ↓ auto-claim
                                                    Librarian Inbox
                                                          ↓ (not built yet)
                                                    Knowledge Base
```

- **Session** — observations extracted per-turn, consolidated into `.memory/<session>/` topic files
- **Wolf (Den)** — persistent across sessions at `$WOLF_DEN/memory/topics/`, injected into system prompt
- **Pack (KB)** — shared knowledge at `~/wolves/knowledge/base/`, curated by Librarian

## Project Layout

```
packages/
  engine/          # Zod schemas, LLM adapter (Anthropic), pipeline utilities
  memory/          # Observer, ledger, session memory, den, consolidation (agent-agnostic)
  agent/           # VPS management HTTP API (port 3141, systemd, per-wolf unix users)
  cli/             # Global CLI: host setup, wolf provisioning, management

extensions/
  wolfpack-memory/ # Pi extension: observer trigger, TUI status, den injection, commands

infra/             # Ansible roles, playbooks, inventory (reference)
legacy/            # Old CLI, core, cc-bot (reference)
docs/planning/     # Architecture docs and design notes
```

## Packages

| Package | Description | Status |
|---|---|---|
| `@wolfpack/engine` | Knowledge schemas, LLM pipeline, adapters | ✅ Built |
| `@wolfpack/memory` | Session memory, observer, den management | ✅ Built & tested |
| `@wolfpack/agent` | VPS management agent (HTTP API) | ✅ Built, untested |
| `@wolfpack/cli` | Pack management CLI | ✅ Built, untested |

## Extensions

| Extension | Description | Status |
|---|---|---|
| `wolfpack-memory` | Pi memory system (observer, consolidator, den, TUI) | ✅ Working |

Extensions are deployed to each wolf's Pi `extensions/` directory. They're loaded by Pi's jiti at runtime, not compiled by the monorepo.

## Wolf Identity

Each wolf has a **6-char nanoid** as its stable identifier and a cosmetic name.

```yaml
# wolf.yaml
id: k7x2m
name: librarian
runtime: pi
model: claude-sonnet-4-6
role: knowledge-curator
domains: [snapjack, wolfpack]
```

VPS layout: `/home/wolf-<id>/` — own unix user, own systemd service.

## CLI Commands

```bash
# Host management
wolfpack host add wolf-01 --ip 100.105.247.31
wolfpack host list
wolfpack host status wolf-01

# Wolf management
wolfpack add wolf librarian --host wolf-01 --role knowledge-curator
wolfpack add wolf test-wolf                    # local wolf
wolfpack list [--json]
wolfpack status <wolf>
wolfpack logs <wolf> [-f]
wolfpack restart <wolf>
wolfpack config <wolf> --set model=claude-sonnet-4-6
```

## Pi Extension Commands

When running as a wolf in Pi:

| Command | Description |
|---|---|
| `/wolf:memory on/off` | Toggle observation |
| `/wolf:status` | Pool size, cost, den path |
| `/wolf:consolidate` | Force observations → session topics |
| `/wolf:promote` | Consolidate → den → auto-claims |
| `/end` | Promote → compact → exit |

## Environment Variables

```bash
# Set in ~/.zshrc or by `wolfpack launch`
WOLF_NAME=1uk4                              # Wolf identity
WOLF_DEN=~/wolves/dens/1uk4/den             # Den path
PI_CODING_AGENT_DIR=~/wolves/dens/1uk4/pi   # Pi config dir
ANTHROPIC_API_KEY=sk-ant-...                # For memory LLM calls
```

## Development

```bash
npm install
npm run build       # Build all packages
npm run typecheck   # Type check without emit
```

## Current Status

**Working end-to-end:**
- Observer → observations → session topics → den topics → system prompt injection
- TUI status bar with pool gauge, observation count, cost
- Compaction renders memory (journey + topic map + observations + den context)

**Built but untested:**
- CLI (wolf provisioning, host management)
- Agent (VPS HTTP API)
- Auto-claim extraction during promotion

**Not yet built:**
- `@wolfpack/librarian` — claim processing pipeline
- Claude Code adapter for VPS wolves
- Backfill existing session history
- KB → wolf context injection (reading shared knowledge)
