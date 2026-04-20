# wolfpack-cc

Telegram command-center bot for the Wolfpack. Runs /status, /logs, /restart against wolves registered in `../inventory/hosts.yml`.

## Commands

- `/status` — each wolf's systemd service state + last activation time
- `/logs <wolf> [lines]` — journalctl tail, default 30, max 200
- `/restart <wolf>` — 2-step. First call prompts you to DM the wolf and have it write a checkpoint. Confirm with `/restart <wolf> confirm` within 5 minutes.

Only the `OWNER_TELEGRAM_ID` can invoke commands. Non-owner updates are logged and dropped.

## Install

Provisioned by Ansible via the `cc-bot` role (see `roles/cc-bot/` in this repo). Running `./bootstrap.sh --limit <cc-host>` creates the `wolfpack` Linux user, installs bun, deploys this code, and starts the systemd unit `wolfpack-cc.service`.

## Secrets

`.env` for the service lives at `/home/wolfpack/wolfpack-cc.env` and is deployed by Ansible from the `TELEGRAM_BOT_TOKEN_WOLFPACK_CC` environment variable. The token comes from @BotFather.

## How /restart interacts with wolves

The bot does NOT ssh into the wolf or coordinate the checkpoint directly. Responsibilities split:

1. User DMs wolf → wolf writes `memory/checkpoints/<ts>.md` (structured via `shared/templates/checkpoint.md`)
2. User sends `/restart <wolf>` to CC bot → bot prompts for confirm
3. User sends `/restart <wolf> confirm` → bot runs `sudo systemctl restart <wolf>.service`
4. On startup, wolf's CLAUDE.md directs it to read the most recent checkpoint in `memory/checkpoints/` (<1h old) and resume from there

Keeping the checkpoint on the user's critical path is deliberate: the CC bot doesn't need to speak for the wolf, and the user gets a moment to choose what to preserve.

## Local dev

Not supported — the bot assumes sudoers rules + systemd units that only exist on the provisioned droplet.
