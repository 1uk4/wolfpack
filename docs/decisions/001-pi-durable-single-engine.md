# 001. pi-durable as the single engine

Date: 2026-10-24. Status: Accepted.

## Context

Wolves today run on the pi coding TUI, reached remotely through a Telegram bridge. Two front ends over different runtimes means duplicated behaviour and no shared structure for the console to render. The console needs one durable conversation runtime with a resumable event log.

## Decision

pi-durable is the only engine for every wolf. The pi coding TUI and the Telegram bridge retire at cutover. pi-durable sits behind an engine interface inside `packages/harness`, and only that package imports it.

## Consequences

- One event model (the pi-durable event-log sequence) feeds conversation streams and `Last-Event-ID` resume.
- The console and `packages/client` stay engine-agnostic; swapping the mock for a real client changes no UI code.
- Behaviour that lived only in the TUI or Telegram must be ported or dropped before cutover.
- The engine interface in `packages/harness` is a deliberate seam if the engine ever changes.
