# 🐺 Wolfpack — PI wolves (experimental)

A **second, parallel agent type** that runs the [pi coding agent](https://pi.dev)
instead of Claude Code. It reuses the exact same Wolfpack infrastructure
(Tailscale, Syncthing dens, the shared library, systemd + tmux) but swaps the
runtime and Telegram integration. **Nothing here touches the existing Claude
wolves** — different inventory group, different playbook, different bootstrap
script. Prove one pi-wolf out, then migrate the rest when you're ready.

## Why pi

- **Structured context is first-class:** `AGENTS.md` context files, skills,
  prompt templates, per-project `.pi/settings.json`, native session persistence.
- **Simpler auth:** an `ANTHROPIC_API_KEY` env var (or one-time `/login`) — no
  OAuth-credential copying between Unix users.
- **No permission popups by design** — tools just run, which is exactly what a
  headless, DM-driven agent needs.

## Telegram bridge

We use the existing **[`@llblab/pi-telegram`](https://github.com/llblab/pi-telegram)**
package (a maintained fork of pi author badlogic's bridge) rather than building
our own. pi has no hidden/headless polling mode: the bridge is owned by a real,
long-lived pi process. So a pi-wolf runs `pi` in a detached tmux session under
systemd (just like the Claude wolves run `claude`), and the startup wrapper
issues `/telegram-connect` once the TUI is up. The owner allowlist is pinned in
`~/.pi/agent/telegram.json` (`profiles.default.allowedUserId`).

## How it maps to the Claude setup

| Concern            | Claude wolf                         | PI wolf                                  |
|--------------------|-------------------------------------|------------------------------------------|
| Inventory group    | `wolves`                            | `pi_wolves`                              |
| Bootstrap          | `./bootstrap.sh`                    | `./bootstrap-pi.sh`                      |
| Playbook           | `playbooks/bootstrap.yml`           | `playbooks/pi-wolf.yml`                  |
| Runtime install    | `roles/claude-code`                 | `roles/pi`                               |
| Telegram           | `roles/telegram` (official plugin)  | `roles/pi-telegram` (`@llblab/pi-telegram`) |
| Den skeleton       | `roles/workspace` (`CLAUDE.md`)     | `roles/pi-workspace` (`AGENTS.md`)       |
| Service            | `roles/wolf-service`                | `roles/pi-wolf-service`                  |
| Shared roles       | `tailscale`, `bun`, `syncthing` (reused unchanged)                          |

The den layout on disk is identical (`/home/wolf/workspace/den` + `shared/`),
so the Syncthing role and your Mac-side hub folders work without changes.

## Quick start

1. **Add a droplet + bot** exactly like a Claude wolf (DO droplet with
   `~/.ssh/wolfpack.pub`, a @BotFather bot token).
2. **`.env`** — set `ANTHROPIC_API_KEY` (headless auth) and
   `TELEGRAM_BOT_TOKEN_<WOLFNAME>`. Leave the key blank to use a Claude
   subscription via a one-time `/login` instead.
3. **Inventory** — uncomment and fill the example host under
   `all.children.pi_wolves.hosts` in `inventory/hosts.yml`:
   ```yaml
   pi-wolf-01:
     ansible_host: <public IP>
     ansible_ssh_private_key_file: ~/.ssh/wolfpack
     ansible_ssh_extra_args: "-o IdentityAgent=none"
     wolf_name: pilot
     pi_role: general
     pi_specialty: "general assistant"
     telegram_bot_token: "{{ lookup('env', 'TELEGRAM_BOT_TOKEN_PILOT') }}"
   ```
4. **Provision:**
   ```bash
   ./bootstrap-pi.sh                 # all pi_wolves
   ./bootstrap-pi.sh --limit pi-wolf-01
   ```
5. **Accept the Syncthing folders** on your Mac (same as a Claude wolf) and
   **DM the bot `/start`** to verify.

## Auth options

- **API key (recommended for headless):** `ANTHROPIC_API_KEY` in `.env` →
  deployed to `~/.pi/agent/pi.env` → loaded by the systemd unit.
- **Subscription:** leave the key empty; the `pi` role pauses with instructions
  to SSH in and run `pi` then `/login` once. Credentials persist in
  `~/.pi/agent/auth.json`.

## Model selection

Set defaults for the whole group in `inventory/hosts.yml` under
`pi_wolves.vars` (`pi_provider`, `pi_model`), or override per host. These land
in `~/.pi/agent/settings.json` as `defaultProvider` / `defaultModel`.

## Operating a pi-wolf

```bash
# Attach to the live pi session (detach with Ctrl-b then d — never Ctrl-c):
sudo -iu wolf tmux attach -t <wolf_name>

# Logs / restart:
journalctl -u <wolf_name> -f
systemctl restart <wolf_name>
```

## Builder / ops wolf

A pi-wolf can double as your **agent on the droplet + repo** — it edits the
Wolfpack framework, runs Ansible, and manages the server. Turn it on per host:

```yaml
forge:
  ...
  wolf_name: forge
  wolf_user: forge                # dedicated user (see co-location below)
  pi_role: ops
  pi_specialty: "wolfpack builder + droplet ops"
  pi_repos:
    - name: wolfpack
      url: git@github.com:<you>/wolfpack.git
```

What this gives the wolf:
- A clone of each `pi_repos` entry under `~/workspace/repos/` (the `pi-repos`
  role). These are **workspace, not memory** — they're pushed to GitHub and you
  pull to your Mac, keeping framework (git) and memory (den/Syncthing) separate.
- `sudo` (already granted to every wolf user) to run Ansible / systemctl.
- An **Ops/Builder section** injected into its `AGENTS.md` with the workflow and
  hard safety rules: never touch another wolf's service/session, inspect before
  acting, prefer the CC bot for routine wolf ops, don't commit dens/secrets.

**Private repo clone needs the wolf's SSH key on GitHub** (the key the playbook
prints — add it, then re-run; clone failures are non-fatal).

### First job for the builder wolf

Once `forge` is running, its first assignment is to build the **Library** — the
pack's canonical shared knowledge store. The full spec (item format, folder
conventions, read/propose flows, validation, phased tasks) is in
**[docs/librarian-spec.md](docs/librarian-spec.md)**.

## Co-location on a shared droplet

Set **`pi_colocated: true`** in inventory. The pi-wolf then runs under the
shared `wolf` user (the same pattern the Claude wolves use), fully isolated by:

- its own den at `/home/wolf/wolves/<name>/den`
- its own pi config dir at `/home/wolf/wolves/<name>/pi` (via `PI_CODING_AGENT_DIR`)
- a dedicated `tmux -L <name>` socket
- its own `<name>.service` unit + startup wrapper

Crucially, its den syncs to your Mac through the host's **existing**
`syncthing@wolf` instance (the `pi-syncthing-folder` role just adds a
`den-<name>` folder via the REST API) — no port clash, no second Syncthing, and
you still get the Obsidian view. On the Mac you only accept the new folder; the
device is already paired.

Modes at a glance:

| Inventory | Layout | Sync |
|-----------|--------|------|
| _(default)_ | dedicated: own user, `~/.pi/agent`, own Syncthing instance | its own `den-<name>` folder |
| `pi_colocated: true` | shared `wolf` user, per-wolf paths + `tmux -L` | via existing `syncthing@wolf` |
| `pi_enable_syncthing: false` | either layout | no sync (den local to droplet) |

## Known limitations / next steps

- **CC bot now manages pi-wolves** — `cc-bot/src/inventory.ts` reads both the
  `wolves` and `pi_wolves` groups, and the `cc-bot` sudoers template grants
  systemctl/journalctl for both. Re-run the `cc-bot` role to apply the updated
  sudoers on the host.
- **Auto-connect is best-effort.** The wrapper waits for pi's TUI banner then
  sends `/telegram-connect`; verify with a `/start` DM. If the pane is stuck on
  a `/login` prompt, the wolf has no credential.
- **No checkpoint-on-restart automation** — pi's native session persistence
  could later replace the manual checkpoint dance the Claude wolves use.
