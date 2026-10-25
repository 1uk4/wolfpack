# 003. Upstream-first dependencies

Date: 2026-10-24. Status: Accepted.

## Context

The current wolfpack implementation vendored custom behaviour into the monorepo where a public package already owned the problem (for example, bridging model calls to the Claude Max subscription exists as the public `pi-claude-bridge`, while wolfpack grew internal routing beside it). Private reimplementations drift from upstream, double the maintenance surface, and lock improvements away from the ecosystem. The owner has named this a mistake not to repeat.

## Decision

Use public packages as published. When wolfpack needs custom tooling or a missing feature in a dependency:

1. Fork the package (or branch it) and build the feature there, not inside the monorepo.
2. Wolfpack depends on the fork only as a bridge measure.
3. Open an upstream PR; when it lands, switch back to the published package.

Combined with the latest-stable policy: wolfpack tracks current releases of its ecosystem, breaking changes included, and adapts promptly.

## Scope — dependencies are chosen selectively

Upstream-first applies where a public package already owns the problem. It is not a mandate to depend on things. Three buckets:

1. **Core domain — always in-house.** What makes wolfpack wolfpack is built and managed here: the memory system (observation → consolidation → den → KB), work/factory semantics, the protocol, the daemons, the console. These are never outsourced to a dependency.
2. **Ecosystem infrastructure — upstream-first.** Engines, frameworks and bridges where a maintained public package owns the problem (pi-durable, pi-claude-bridge, Next.js, turbo): consume as published; fork + PR for gaps.
3. **Small utilities — just write them.** Quick, easy tooling is not worth a dependency; own code wins.

The test for adding a dependency: does a maintained package own this problem better than we would, and is the problem outside our core domain? Both yes → depend. Otherwise → build.

## Consequences

- Wolfpack's own packages contain only what is genuinely wolfpack-specific (daemons, protocol, memory/work semantics, console).
- Forks are temporary and tracked as work items until the upstream PR resolves.
- Some needs wait on upstream review; the fork keeps development unblocked in the meantime.
- First application: `pi-claude-bridge` gains pi-durable support via fork + upstream PR (work-wolfpack-p81a6iI) instead of a wolfpack-internal subscription bridge.
