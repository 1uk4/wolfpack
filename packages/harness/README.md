# @wolfpack/harness

## wolfd turn safety nets

**Stop keeps your messages.** Messages you send while a turn is running are queued as steers. If you click Stop (or the
stall watchdog aborts the turn) before they were placed, wolfd re-sends them after the abort settles, in order, as one
combined next message (attachments carried along). Messages the engine already placed are never re-sent, and internal
submits (subagent result deliveries) are not re-sent here: their own drain logic redelivers them. If the re-send itself
fails, an `error` event quotes the text and it is retried once.

**Stall watchdog.** A running turn with no engine event (model stream, message, tool or run event) for
`stallTimeoutMs` while no tool is executing gets an `error` thread event ("Turn stalled: no activity for Ns. Aborting
it.") and is aborted; queued owner messages then flow into the next turn and held subagent results are delivered.
Queued owner submissions and snapshots do not count as activity. Long-running tools never trip it.

- Default: 120000 ms (above the pi-claude-bridge 90 s idle timeout, so it only fires if the bridge itself is wedged).
- `0` disables it.
- Set with `WolfServerOptions.stallTimeoutMs` or the `WOLFPACK_STALL_TIMEOUT_MS` environment variable of wolfd.
