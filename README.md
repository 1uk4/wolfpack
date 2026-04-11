# 🐺 Wolfpack

> A fleet of always-on Claude Code agents ("wolves") that you can DM on Telegram. Each wolf lives on its own Linux host, has a persistent Obsidian-compatible brain ("den"), and syncs bidirectionally with your Mac. The whole pack is provisioned with one command.

---

## What is this?

A wolf is a Debian server (DigitalOcean droplet by default) running:

- **Claude Code** in a detached `tmux` session under `systemd`, listening on a Telegram channel via the official `claude-plugins-official/telegram` plugin.
- **Tailscale** for private networking between your Mac and every wolf.
- **Syncthing** wired into a hub-and-spoke topology with your Mac, so each wolf's `den/` (its memory, identity, and working files) is always in sync with `~/Code/wolfpack/dens/<wolf>/` on your laptop, viewable/editable in Obsidian.

You DM a wolf on Telegram → it runs Claude with access to its den → it responds. Meanwhile the pack has a shared read-only library at `~/Code/wolfpack/shared/` that the Mac pushes to every wolf, so skills and pack knowledge propagate automatically.

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│                1uk4's Mac (Hub)                 │
│                                                 │
│   ~/Code/wolfpack/                              │
│     ├── shared/     (git-tracked, send-only  ──┼──┐
│     └── dens/       (gitignored, bidi sync) ───┼──┤
│           └── scout/                            │  │
│                                                 │  │
│   Syncthing @ localhost:8384                    │  │
└─────────────────────────────────────────────────┘  │
                                                     │ Tailscale
                            ┌────────────────────────┘
                            │
                            ▼
                 ┌─────────────────────┐
                 │  scout (DO droplet) │
                 │                     │
                 │  /home/wolf/workspace/
                 │    ├── den/     ◄─── bidi
                 │    └── shared/  ◄─── receive-only
                 │                     │
                 │  systemd → tmux → claude
                 │              └── telegram plugin
                 └─────────────────────┘
```

**Sync rules:**
- `shared/` — Mac sends, wolves receive. Mac is the source of truth; wolves can't modify it.
- `dens/<wolf>/` — Bidirectional between Mac and that specific wolf. Each wolf only has its own den.
- Never wolf-to-wolf (yet).

**Network:**
- Public SSH (port 22) is used only for the first bootstrap. After Tailscale comes up, all future runs go over the tailnet.
- `ufw` allows inbound on the `tailscale0` interface, so Syncthing, SSH, and web UIs are reachable over the tailnet without exposing anything to the public internet.

---

## Prerequisites (one-time, on your Mac)

1. **Homebrew** — https://brew.sh
2. **Ansible** — `brew install ansible` (or `pipx install ansible`)
3. **An SSH keypair for the pack:**
   ```
   ssh-keygen -t ed25519 -f ~/.ssh/wolfpack -C "wolfpack" -N ""
   ```
   Then add `~/.ssh/wolfpack.pub` to your DigitalOcean account's SSH keys (Settings → Security → Add SSH Key) **before creating any droplet**, so DO bakes it into `/root/.ssh/authorized_keys` on first boot.
4. **A Tailscale account** — https://tailscale.com — and a reusable auth key from https://login.tailscale.com/admin/settings/keys.
5. **A Telegram bot per wolf** — DM [@BotFather](https://t.me/BotFather), send `/newbot`, save the token.
6. **Your Anthropic account logged into Claude Code locally** — because provisioning copies credentials from `root`'s first login on the wolf to the `wolf` user.

`bootstrap.sh` will install Syncthing for you via Homebrew on first run.

---

## Quick start

```bash
git clone <this-repo> ~/Code/wolfpack
cd ~/Code/wolfpack
cp .env.example .env
$EDITOR .env                         # fill in real values
./bootstrap.sh
```

That's it. `bootstrap.sh` takes you through the rest: prereq checks, IP prompting, Ansible run, mid-run pauses for any manual OAuth, and a final checklist.

---

## Configuration

### `.env`

```
TAILSCALE_AUTHKEY=tskey-auth-...
TELEGRAM_BOT_TOKEN_SCOUT=1234567890:AAH...
MAC_SYNCTHING_DEVICE_ID=ABCDEFG-HIJKLMN-OPQRSTU-VWXYZAB-CDEFGHI-JKLMNOP-QRSTUVW-XYZABCD
```

- **`TAILSCALE_AUTHKEY`** — reusable key from the Tailscale admin.
- **`TELEGRAM_BOT_TOKEN_<WOLFNAME>`** — one per wolf, matching the `wolf_name` in inventory.
- **`MAC_SYNCTHING_DEVICE_ID`** — the 56-char ID from your Mac's Syncthing (top-right menu → "Show ID").

### `inventory/hosts.yml`

```yaml
all:
  vars:
    wolf_user: wolf
    owner_telegram_id: "YOUR_TELEGRAM_USER_ID"
    mac_syncthing_device_id: "{{ lookup('env', 'MAC_SYNCTHING_DEVICE_ID') }}"
  children:
    wolves:
      hosts:
        wolf-01:
          ansible_host: 64.23.132.160   # DO droplet public IP (swapped to Tailscale after bootstrap)
          ansible_ssh_private_key_file: ~/.ssh/wolfpack
          ansible_ssh_extra_args: "-o IdentityAgent=none"
          wolf_name: scout
          telegram_bot_token: "{{ lookup('env', 'TELEGRAM_BOT_TOKEN_SCOUT') }}"
```

Your numeric Telegram user ID (owner) goes in `owner_telegram_id`. You can get yours from [@userinfobot](https://t.me/userinfobot).

---

## What `bootstrap.sh` does

Run from the repo root. All prereq failures print the exact fix command.

1. **Checks for `ansible-playbook`** → install hint if missing.
2. **Checks for `~/.ssh/wolfpack` keypair** → `ssh-keygen` command if missing.
3. **Checks `.env`** → creates from `.env.example` if missing; flags any `REPLACE_ME` values with instructions on where to get each secret.
4. **Checks Syncthing** on your Mac → installs via `brew install syncthing` if missing, starts the service if not running.
5. **Creates `shared/` and `dens/`** inside the repo (dens is gitignored).
6. **Lists wolves in inventory** and prompts for the current IP of each one. Press Enter to keep the existing value or paste a new IP after a droplet rebuild.
7. **Clears stale SSH host keys** for both old and new IPs.
8. **Runs the Ansible playbook** with any extra args forwarded.

---

## What the Ansible playbook does

Roles run in this order against every wolf in the inventory:

1. **`tailscale`** — Installs Tailscale, authenticates with the auth key, opens `tailscale0` in UFW.
2. **`bun`** — Installs Bun (runtime for the Telegram plugin's MCP server).
3. **`claude-code`** — Installs Node.js + `@anthropic-ai/claude-code`. Auto-copies Claude credentials from `root`'s local login to the `wolf` user. If neither is logged in, the playbook pauses with instructions for a one-time `claude auth login` in a second terminal.
4. **`telegram`** — Installs the official telegram plugin, writes the bot token, pre-allowlists your owner ID so stranger DMs are dropped.
5. **`workspace`** — Creates the full den skeleton (see [Den structure](#den-structure)) and pre-trusts `/home/wolf/workspace/den` in `~/.claude.json` so Claude won't hit the "trust this folder?" prompt under systemd.
6. **`syncthing`** — Installs Syncthing, calls its local REST API to add your Mac as a remote device and create two folders (`den-<wolf>` as send/receive, `wolfpack-shared` as receive-only) both shared with your Mac.
7. **`wolf-service`** — Deploys a systemd unit that runs `claude --channels plugin:telegram@claude-plugins-official` inside a detached `tmux` session. A smoke test polls the tmux pane for the "Listening for channel messages" banner and fails the play loudly if it doesn't appear within ~120s.

**Post-tasks (on localhost):**
- Rewrites `inventory/hosts.yml` for that host to point at its Tailscale IP.
- Rewrites `~/.ssh/config`'s `Host wolfpack` alias to the Tailscale IP.
- Prints a final checklist with anything that still needs a human — mostly the one-time Mac-side Syncthing folder accepts.

---

## Den structure

Every wolf's `/home/wolf/workspace/` looks like this:

```
workspace/
├── den/                    # Private brain (bidi sync with Mac)
│   ├── CLAUDE.md           # Identity + role + startup instructions
│   ├── SOUL.md             # Personality, voice, boundaries
│   ├── MEMORY.md            # Routing index → memory/*.md
│   ├── memory/
│   │   ├── human.md         # What the wolf knows about you
│   │   ├── decisions.md     # Key decisions
│   │   ├── lessons.md       # Mistakes + learnings
│   │   └── daily/
│   │       └── YYYY-MM-DD.md
│   ├── tasks/
│   │   ├── inbox.md         # New assignments from you
│   │   ├── active.md        # Currently working on
│   │   └── done.md          # Append-only log
│   ├── knowledge/           # Domain notes the wolf creates
│   ├── reports/             # Long-form output for you
│   └── .stignore            # .obsidian/, .DS_Store, etc.
└── shared/                 # Pack library (receive-only from Mac)
    ├── skills/
    ├── templates/
    └── pack/
```

`wolf-service` runs `claude` with `WorkingDirectory=/home/wolf/workspace/den`, so Claude picks up `den/CLAUDE.md` as its main instruction file. Referencing `../shared/` in CLAUDE.md points it at the pack library.

### How it syncs

- **`~/Code/wolfpack/dens/scout/` on your Mac** ↔ **`/home/wolf/workspace/den/` on scout** — bidirectional. Edit either side, changes propagate.
- **`~/Code/wolfpack/shared/` on your Mac** → **`/home/wolf/workspace/shared/` on every wolf** — one-way. Editing `shared/` in the repo and committing to git is how you push updates to the whole pack.

### Viewing in Obsidian

Open `~/Code/wolfpack/dens/<wolf>/` as an Obsidian vault, or create a master vault at `~/Code/wolfpack/dens/` that treats each wolf as a subfolder. You get graph view, search, and direct editing of every wolf's memory.

Assign a task by editing `dens/scout/tasks/inbox.md` in Obsidian. Syncthing pushes it to the wolf within seconds, and the wolf picks it up on its next session.

---

## Adding a new wolf

1. Create a new DigitalOcean droplet (Debian 13 recommended) with `~/.ssh/wolfpack.pub` attached.
2. Create a new bot via [@BotFather](https://t.me/BotFather), copy the token.
3. Add the token to `.env`:
   ```
   TELEGRAM_BOT_TOKEN_SENTINEL=...
   ```
4. Add the host to `inventory/hosts.yml`:
   ```yaml
   wolf-02:
     ansible_host: <public IP>
     ansible_ssh_private_key_file: ~/.ssh/wolfpack
     ansible_ssh_extra_args: "-o IdentityAgent=none"
     wolf_name: sentinel
     telegram_bot_token: "{{ lookup('env', 'TELEGRAM_BOT_TOKEN_SENTINEL') }}"
   ```
5. `./bootstrap.sh` — or to provision only the new wolf: `./bootstrap.sh --limit wolf-02`.
6. During the mid-run pause (if any), log into Claude once on the new droplet via `claude auth login`.
7. After the run, accept the two Syncthing folder shares on your Mac:
   - `den-sentinel` → `~/Code/wolfpack/dens/sentinel` (Send & Receive)
   - `wolfpack-shared` → `~/Code/wolfpack/shared` (Send Only, may already exist from scout)
   - Click Edit on the new device and set Addresses to `tcp://<tailscale-ip>:22000`.

---

## Manual steps that can't be automated

Only two things, and both are one-time per wolf:

1. **Claude OAuth login on the droplet** — Claude Code's OAuth flow needs an interactive TTY; it can't be piped through Ansible. The playbook pauses with the exact `ssh` and `claude auth login` commands to paste into a second terminal.
2. **Mac-side Syncthing folder accepts** — We can configure everything from the wolf side via Syncthing's REST API, but the Mac has to actually click "Accept" on the incoming device + folder shares. The playbook prints the exact click-through steps.

---

## Troubleshooting

### The playbook reports "wolf-service active" but the Telegram bot doesn't reply

Most likely cause: Claude inside the tmux session is stuck on a first-run dialog (folder trust, warnings, etc.). Attach to the live pane:

```
sudo -iu wolf tmux attach -t <wolf_name>
```

Read what's on screen. Press the right key to dismiss any prompt. Detach with **Ctrl-b d** (never Ctrl-c — that kills Claude).

### Mac Syncthing shows "Disconnected (Never seen)" for a wolf

The Mac can't reach the wolf's Syncthing daemon. Check:

1. **UFW on the wolf** — `ufw status | grep tailscale0`. Should show an `ALLOW IN` rule. The `tailscale` role opens this automatically; if it's missing, run the role again.
2. **Device address on the Mac** — Click Edit on the wolf device in Mac Syncthing and set Addresses to `tcp://<tailscale-ip>:22000` instead of `dynamic`.
3. **The actual Syncthing process** — `ss -tlnp | grep 22000` on the wolf should show `syncthing` listening.

### Claude keeps asking to log in after you've logged in

You probably logged in as `root` but Claude is running as `wolf`. Credentials aren't shared between Unix users. Either:

- `sudo -iu wolf claude auth login` to log in as the wolf user directly, or
- Let the playbook's `claude-code` role auto-copy `root`'s credentials to `wolf` (which it does when `root` is authed).

### After a droplet rebuild, `ssh wolfpack` hangs

Rebuild gives the droplet a new host key. `bootstrap.sh` clears stale `known_hosts` entries for you, but if you hit this outside of a playbook run:

```
ssh-keygen -R <tailscale-ip>
ssh-keygen -R <public-ip>
```

---

## File layout reference

```
wolfpack/
├── .env.example                          # Template for secrets
├── .gitignore                            # Ignores .env, dens/, syncthing metadata
├── README.md                             # You are here
├── ansible.cfg                           # Points at inventory/hosts.yml
├── bootstrap.sh                          # One-command entry point
├── inventory/
│   └── hosts.yml                         # Wolf inventory + group vars
├── playbooks/
│   └── bootstrap.yml                     # Main play: pre_tasks + roles + post_tasks
├── roles/
│   ├── tailscale/                        # Install + auth + UFW tailscale0 rule
│   ├── bun/                              # Install Bun as the wolf user
│   ├── claude-code/                      # Install CLI + copy credentials
│   ├── telegram/                         # Install plugin + configure access
│   ├── workspace/
│   │   ├── tasks/main.yml                # Build the den skeleton
│   │   └── templates/den/                # CLAUDE.md, SOUL.md, MEMORY.md templates
│   ├── syncthing/                        # Install + REST API folder config
│   └── wolf-service/
│       ├── tasks/main.yml                # Deploy unit, smoke-test pane
│       ├── handlers/main.yml             # restart wolf handler
│       └── templates/wolf.service.j2     # systemd unit
├── dens/                                 # gitignored; Mac-side wolf dens live here
└── shared/                               # git-tracked; pushed to every wolf
    ├── skills/
    ├── templates/
    └── pack/
```

---

## Security notes

- **No secrets in git.** `.env` is gitignored; credentials live in `keys/` (also gitignored).
- **No public internet exposure after Tailscale is up.** UFW allows SSH on public interfaces only until you firewall it off; `tailscale0` is the only interface Syncthing and other services listen on.
- **Telegram allowlist by default.** The `telegram` role writes an `access.json` that pre-allowlists only your owner ID (`owner_telegram_id` in inventory). Strangers DMing the bot get dropped silently.
- **Shared folder is receive-only on wolves.** A compromised wolf can't poison the shared skill library.
- **Claude runs as the unprivileged `wolf` user**, not root, with `sudo` access only if you configure it.

---

## License

Your own. Not affiliated with Anthropic.
