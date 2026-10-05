# Wolfpack Architecture

A framework for running personalized AI agents with persistent memory.

---

## Layers

```
┌─────────────────────────────────┐
│  4. Interface                   │  How wolves talk to the world
├─────────────────────────────────┤
│  3. Wolf                        │  Agent runtime + identity
├─────────────────────────────────┤
│  2. Memory                      │  Persistent storage (dens, KB)
├─────────────────────────────────┤
│  1. Control                     │  CLI, config, usage tracking
└─────────────────────────────────┘
```

---

### Layer 1: Control

The operator's interface. Runs on the host machine.

**Responsibilities:**
- Pack configuration
- Wolf provisioning
- Usage & cost tracking
- Deployment to local or remote

**Entry point:** `wolfpack` CLI

---

### Layer 2: Memory

Where everything persists. Wolves are stateless — memory is external.

**Components:**
- **Dens** — Per-wolf working memory
- **Librarian** — Claim inbox, receipts, processing
- **Knowledge Base** — Curated entries, queryable

**Location:** Configurable (default `~/wolves/`)  
**Sync:** Hub-and-spoke from host machine to remote wolves

---

### Layer 3: Wolf

An agent process with identity, instructions, and a provider connection.

**What defines a wolf:**
- Name + role
- System prompt / personality
- Provider + model
- Pointer to its den (Layer 2)
- Deployment target (local or remote)

**Runtime:** A wolf is just a process that reads its config, connects to a provider, and reads/writes to its den.

---

### Layer 4: Interface

How a wolf receives and responds to messages.

**Examples:**
- Telegram bot
- CLI (stdin/stdout)
- HTTP API
- Pi agent session

**Interfaces are pluggable.** A wolf can have multiple interfaces.

---

## What's Core vs. What's Optional

| Component | Core | Optional |
|---|---|---|
| CLI (`wolfpack`) | ✅ | |
| Wolf config (YAML) | ✅ | |
| Dens (file-based memory) | ✅ | |
| Knowledge Base | ✅ | |
| Librarian (claim processing) | ✅ | |
| Usage tracking | ✅ | |
| Syncthing sync | | ✅ |
| Telegram interface | | ✅ |
| Web dashboard | | ✅ |
| Ansible deployment | | ✅ |
| Multi-provider support | | ✅ |

---

## One Sentence Per Layer

1. **Control** — You tell the pack what to do.
2. **Memory** — The pack remembers.
3. **Wolf** — An agent that thinks.
4. **Interface** — The world talks to the agent.
