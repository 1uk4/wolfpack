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
│    1uk4/  (local wolf, Pi sessions)         │               │
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

## Packages

| Package | Description | Status |
|---|---|---|
| `@wolfpack/engine` | Knowledge schemas, LLM pipeline, adapters | 🟢 Built |
| `@wolfpack/memory` | Session memory, observer, den management | 🟢 Built |
| `@wolfpack/pi-extension` | Pi agent adapter for wolfpack memory | 🟢 Built |
| `@wolfpack/agent` | VPS management agent (HTTP API) | 🟢 Built |
| `@wolfpack/cli` | Pack management CLI | 🟢 Built |

## Project Layout

```
packages/
  engine/          # Core: schemas, search, parse, commit, index generation
  memory/          # Memory: observer, ledger, session, den, consolidation
  pi-extension/    # Pi adapter: thin bridge to Pi's extension API
  agent/           # VPS agent: HTTP API managing wolf processes
  cli/             # CLI: host setup, wolf provisioning, management

infra/             # Ansible roles, playbooks, inventory (reference)
legacy/            # Old CLI, core, cc-bot (reference)
docs/planning/     # Architecture docs and design notes
```

## Quick Start

### Install CLI

```bash
npm install -g @wolfpack/cli
```

### Create a Local Wolf

```bash
wolfpack add wolf 1uk4
```

### Set Up a VPS

```bash
wolfpack host add wolf-01 --ip 100.105.247.31
```

### Create a Remote Wolf

```bash
wolfpack add wolf librarian --host wolf-01 --role knowledge-curator
```

### Manage Wolves

```bash
wolfpack list                          # All wolves across hosts
wolfpack status librarian              # Service state
wolfpack logs librarian -f             # Stream logs
wolfpack restart librarian             # Restart
wolfpack config librarian --set model=claude-sonnet-4-6
```

## Wolf Identity

Each wolf has a **6-char nanoid** as its stable identifier and a cosmetic name.
Names can change; IDs never do.

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

## Development

```bash
npm install
npm run build
npm run typecheck
npm test
```
