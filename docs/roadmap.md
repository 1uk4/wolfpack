# Wolfpack Roadmap — Dockerization, KB-as-a-Service, Pi Durable

> Strategic phasing for moving Wolfpack to ephemeral containers + a server-authoritative
> knowledge base, without blocking day-to-day use. Companion spec for Phase 1:
> `docs/factory-design.md`.

## Status legend
- ✅ built · 🟡 designed/partial · ⬜ to build

---

## The invariants (decided)

These hold across every phase — they are the fixed points the roadmap builds around.

1. **Your dev environment is the pi coding-agent CLI. Always.**
   Earendil is explicit that Pi Durable *does not replace* the coding agent, which is
   built for terminal-driven, single-person work. Your laptop "dev wolf" is the pi CLI
   in a container with a repo mounted — never a Pi Durable app.

2. **The KB is a first-class component, not a wolf.**
   It is a dockerized **service** that owns the store and speaks an API. Certain wolves
   (Dewey) hold a **write** token and manage it; everyone else holds a **read** token.
   The store stays plain files (git- and Obsidian-native) behind the daemon.

3. **The VPS is authoritative. The Mac is a cold backup + ephemeral worker host.**
   Nothing authoritative runs locally. The system must run on the server entirely.

4. **Every wolf is a uniform KB client over Tailscale.**
   One access path, one auth model. The CLI injects three things into every wolf
   container: `KB_ENDPOINT` (the KB host's MagicDNS name), `KB_TOKEN` (read/write), and
   Tailscale reachability. This is what makes wolves location-independent and multi-VPS
   trivial — a new VPS is just another dialer of the same endpoint.

5. **Container = disposable compute. Host + volumes = identity, state, mesh.**
   A wolf's durability lives in its den, its `.pi/agent` config, and (for the KB) the
   store volume — never in the process.

6. **The Wolfpack CLI is the backbone and is runtime-agnostic.**
   It orchestrates: image → volumes → secrets/tokens → mesh/backup → container lifecycle.
   `wolf.service` already carries a `wolf_runtime` switch (`claude` | `pi`); Pi Durable
   would be a third runtime. What runs *inside* the container never changes what the CLI
   does *around* it.

---

## Phase 1 — Factory (task system), on the current pi CLI ⬜ · **start here**

Deliver a usable task system **now**, file-first, before any container or service work.
Full spec: `docs/factory-design.md`.

- Wire the **WorkItem** node (the KB's designed-but-unbuilt "Factory" layer) on the
  existing shared `EventLog` primitive (which already names the WorkItem stage machine as
  its intended consumer).
- Two orthogonal axes: a **work tree** (`part_of`: initiative → feature → task) and an
  **area** field (marketing, analysis, …) within a domain.
- Add **`success_criteria`** to each item; **`assignee`** is a wolf id (`1uk4`, `hal`, …).
- A **`/task` pi extension**: bind a session to a WorkItem, render it into the system
  prompt, advance stage, append progress, link KB entries used.
- **Graduation**: shipped work flows into Library entries via the existing
  promote → inbox → sweep path; `area` → the entry's `subsystem` facet.
- **Storage:** `knowledge/base/domains/<domain>/work/<id>.md` (parallel to `entries/`),
  Obsidian-viewable; stage history in the event ledger.

*Milestone:* `/task use <id>` in your dev session → you work → the item updates and feeds
the KB. No Docker, no API required.

---

## Phase 2 — KB as a dockerized service + API ⬜

Make the KB authoritative on the VPS and reachable over Tailscale.

- **KB daemon** wrapping the existing file engine: `resolve` / `search` / `contribute`
  **+ WorkItem CRUD** endpoints.
- **Ollama** sidecar (embeddings for search + routing); automated **sweep** on a timer;
  **token auth** (Dewey = write, others = read).
- **KB client pi extension** — API calls replace direct file reads (`client/resolve.ts`).
  This is the piece your own dev env needs first.
- **Syncthing** shrinks from a per-wolf star to a single **cold-backup** pipe VPS → Mac.

*Milestone:* your pi CLI dev wolf reads/writes the authoritative VPS KB live; the Factory
is service-backed with no data-model change (same WorkItem files, now behind the API).

---

## Phase 3 — Containerize wolves + `DockerBackend` ⬜

Wolves become ephemeral containers managed by the Wolfpack CLI.

- **Base wolf image** (pi's official containerization recipe: `node` + pi + git/ripgrep,
  `ENTRYPOINT ["pi"]`); named volume for `.pi/agent`, bind mount for the workspace.
- **Dev wolf:** `docker run -it`, repo bind-mounted, `KB_ENDPOINT`/`KB_TOKEN` injected.
- **Daemon wolf:** `docker run -dit` + restart policy (replaces systemd + tmux); Telegram
  outbound.
- **`DockerBackend`** implementing the existing `WolfBackend` contract
  (`list/status/logs/restart/remove` → docker API); `wolfpack launch` drives Docker.

*Milestone:* `wolfpack launch dev-wolf` gives you a containerized dev environment wired to
the VPS KB; VPS daemon wolves run as containers.

**Known unknown (pi-runtime daemon wolves only):** headless Telegram auto-connect without
tmux pane-scraping. Does not affect the interactive dev wolf. Dissolved entirely if daemon
wolves move to Phase 4.

---

## Phase 4 — Pi Durable for the 24/7 daemon wolves ⬜ · the bet, last

Migrate **daemon** wolves (not the dev env) to Pi Durable for crash-survival, multi-surface
reach, and remote execution environments.

- Why it fits: **survives crashes/redeploys** (SQLite + task checkpoints) reconciles
  "ephemeral container" with "persistent agent"; **runs anywhere** + **remote execution
  environments** fit multi-VPS and the laptop/VPS split; **multiplayer** lets Telegram
  *and* the CLI attach to the same wolf; **malleable** hot-swaps extensions.
- Build the durable harness: SQLite storage, a Telegram surface, port the KB tool, model
  memory as durable `tasks`/`docs`. The CLI gains a **client-surface** role
  (attach/watch/steer) on top of its management role.
- **Caveats:** experimental (API may change); it is a *framework you build on*, not a
  wrapper — real engineering. Mitigant: the KB engine and memory logic are already
  agent-agnostic TypeScript and port as tools/docs/tasks.
- **Dev env stays on the pi CLI**, untouched.

*Milestone:* VPS wolves survive redeploys and are reachable from Telegram + CLI; the dev
environment is unchanged.

---

## Why this order

Phases 1–2 deliver the thing you actually use daily — task-tracked sessions that feed the
KB — **before** any container or framework migration. Phases 3–4 are infrastructure placed
under a system you are already living in. The experimental bet (Pi Durable) is last and
optional, which is the lowest-regret position, and the CLI/KB/container scaffolding is
runtime-agnostic so none of it is wasted if the runtime choice changes.
