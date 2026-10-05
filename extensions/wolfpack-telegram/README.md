# wolfpack-telegram

Headless-first Telegram bridge for wolfpack wolves.

A thin adaptation of [badlogic/pi-telegram](https://github.com/badlogic/pi-telegram)
(MIT) for 24/7 VPS wolves that run `pi --mode rpc` under systemd with **no TUI**.

## What changed from upstream

| Concern | badlogic/pi-telegram | wolfpack-telegram |
| --- | --- | --- |
| Activation | TUI `/telegram-setup` + `/telegram-connect` | **auto-connects on `session_start`** when `TELEGRAM_BOT_TOKEN` is in env |
| Config location | `~/.pi/agent/telegram.json` | `$PI_CODING_AGENT_DIR/telegram.json` (per-wolf isolation) |
| Token storage | persisted in `telegram.json` | kept in env; only identity/pairing persists when env-provided |
| Pairing | first `/start` DM becomes owner | first `/start` **or** preconfigured `TELEGRAM_OWNER_ID` |
| UI | status bar + notifications | all `ctx.ui` guarded by `ctx.hasUI` (no-ops headless) |

The upstream mechanics are preserved: long-poll, owner gating, inbound
text/images/files, the `telegram_attach` tool for sending artifacts back,
streaming previews, `stop`, and prompt queueing while busy.

## Configuration (headless wolves)

The wolfpack agent writes these into the wolf's `.env`:

- `TELEGRAM_BOT_TOKEN` — bot token from [@BotFather](https://t.me/BotFather) (required)
- `TELEGRAM_OWNER_ID` — numeric Telegram user id to pre-pair (optional; else the
  first `/start` DM pairs)

With the token present, the bridge connects automatically when the wolf starts.

## Interactive use

For local/TUI wolves without the env token, the upstream flow still works:
`/telegram-setup`, `/telegram-connect`, `/telegram-disconnect`, `/telegram-status`.

## License

MIT (inherits upstream). See attribution above.
