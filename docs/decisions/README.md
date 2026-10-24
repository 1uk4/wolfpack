# Decisions

Architecture decision records. Each is short: context, decision, consequences.

- Files are named `NNN-short-title.md`, numbered in order.
- **Append-only.** Do not edit an accepted ADR to change its meaning. To reverse or refine one, write a new ADR and mark the old one `Superseded by NNN` in its status line (the only permitted edit).
- Current state belongs in [../architecture.md](../architecture.md), not here.

| # | Title | Status |
|---|---|---|
| 001 | [pi-durable as the single engine](001-pi-durable-single-engine.md) | Accepted |
| 002 | [Hub / worker daemon split](002-hub-worker-daemon-split.md) | Accepted |
