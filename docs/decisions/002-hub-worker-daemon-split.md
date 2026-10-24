# 002. Hub / worker daemon split

Date: 2026-10-24. Status: Accepted (not yet built).

## Context

Wolves run on several machines (VPS and Mac). Today they are managed by a per-host agent, files are mirrored with Syncthing, and nothing gives one place for the registry, the Work API and KB access control.

## Decision

Two separate daemons, even on one machine, built from the same packages and speaking one protocol locally and remotely:

- **hubd:** pack registry, Work API and ledger, KB authority, contributions inbox, relay. A role, not a fixed machine; it starts on the Mac and ends on a VPS. Moving it is a supported export/import.
- **workerd:** runs one process per wolf (`ProcessRunner`), holds dens, workspaces and the KB copy. Workers dial out to the hub and keep the connection open. Wolves talk only to their own worker and never hold hub credentials.

Transport is POST for commands and SSE for streams, resumable with `Last-Event-ID`. Tokens are always required; Tailscale, TLS or a local socket provide the network layer. Syncthing is retired; workers pull the KB from the hub, which enforces domain access.

## Consequences

- No inbound ports on workers; hub location can change without reconfiguring them.
- Development uses a local hub on a copy of production data, with dev wolves in sandbox mode.
- A new protocol package and token/pairing flow must be built before any remote wolf works.
- Two sequencing domains: pi-durable log sequence for conversations, hub-minted sequences for pack-wide streams.
- Legacy `packages/agent` and the Syncthing mesh are removed at cutover.
