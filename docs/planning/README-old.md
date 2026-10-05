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

The Mac is the hub. Every wolf is a spoke; nothing is ever wolf-to-wolf.

```
                    ┌──────────────────────────────────────┐
                    │           1uk4's Mac  (hub)          │
                    │                                      │
                    │  ~/Code/wolfpack/  ← one Obsidian    │
                    │    │                 vault root      │
                    │    ├── shared/       send-only    ──►│
                    │    ├── dens/         bidirectional ◄►│
                    │    │     ├── hal/                    │
                    │    │     └── snapjack-bi/            │
                    │    └── knowledge/    bidirectional ◄►│
                    │          └── snapjack/               │
                    │                                      │
                    │  Syncthing @ localhost:8384          │
                    └──────────────────┬───────────────────┘
                                       │ Tailscale
                                       ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │  wolf-01   Debian droplet · 2 vCPU / 2 GB · one Unix user (`wolf`)   │
  │                                                                      │
  │  /home/wolf/                                                         │
  │    ├── workspace/den/               hal's den    ← the first wolf    │
  │    ├── workspace/shared/            receive-only pack library        │
  │    ├── wolves/snapjack-bi/den/      snapjack-bi's den                │
  │    ├── wolves/snapjack-bi/claude/   its own CLAUDE_CONFIG_DIR        │
  │    └── knowledge/snapjack/          kb folder, symlinked into dens   │
  │                                                                      │
  │  systemd ─┬─ hal.service          → tmux → claude → telegram plugin  │
  │           └─ snapjack-bi.service  → tmux → claude → telegram plugin  │
  │                                                                      │
  │  support:  syncthing@wolf · tailscaled · wolfpack-cc (bot)           │
  └──────────────────────────────────────────────────────────────────────┘
```

The first wolf on a host sits in `workspace/den`; wolves added later get
`wolves/<name>/` with their own Claude config dir. Every script resolves both
shapes — see [Two den locations](#two-den-locations) for why the split exists.

**Sync rules** — three folder classes, all shared with the hub and only the hub:

| Syncthing folder | Type | On the wolf | On the Mac |
| --- | --- | --- | --- |
| `wolfpack-shared` | Mac sends, wolf receives | `workspace/shared/` | `~/Code/wolfpack/shared/` |
| `den-<wolf>` | bidirectional | `wolves/<wolf>/den/` | `~/Code/wolfpack/dens/<wolf>/` |
| `kb-<topic>` | bidirectional | `knowledge/<topic>/` | `~/Code/wolfpack/knowledge/<topic>/` |

- The Mac is the source of truth for `shared/`; wolves cannot modify it.
- Each wolf sees only its own den. Never wolf-to-wolf.
- A `kb-<topic>` folder is symlinked into each den that needs it, and excluded
  from that den's own sync so it is not carried twice. `wolfpack sync` does the
  wiring and the ignores.
- Because all three land under `~/Code/wolfpack/`, opening that one directory as
  an Obsidian vault makes wikilinks resolve across dens and knowledge alike.

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
TELEGRAM_BOT_TOKEN_HAL=1234567890:AAH...
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
          wolf_name: hal
          telegram_bot_token: "{{ lookup('env', 'TELEGRAM_BOT_TOKEN_HAL') }}"
```

Your numeric Telegram user ID (owner) goes in `owner_telegram_id`. You can get yours from [@userinfobot](https://t.me/userinfobot).

---

## Interaction layer (`wolf_runtime`)

Each wolf runs one of two interaction layers, selected per wolf by
`wolf_runtime` in inventory (default `claude`):

| `wolf_runtime` | Agent | Telegram transport | Config dir |
|---|---|---|---|
| `claude` | Claude Code CLI | `telegram` plugin channel | `CLAUDE_CONFIG_DIR` |
| `pi` | pi coding agent | `@llblab/pi-telegram` bridge | `PI_CODING_AGENT_DIR` |

```yaml
        forge:
          # ...host/ssh...
          wolf_name: forge
          wolf_runtime: pi
          wolf_den: /home/wolf/wolves/forge/den
          wolf_config_dir: /home/wolf/wolves/forge/pi
          telegram_bot_token: "{{ lookup('env', 'TELEGRAM_BOT_TOKEN_FORGE') }}"
```

**The den is runtime-agnostic** — both agents load `AGENTS.md` and `memory/`
from the same vault — so a wolf's memory and identity survive a runtime
switch. Only the systemd wrapper changes. `pi` wolves also need a provider key
(`ANTHROPIC_API_KEY`); `claude` wolves use OAuth creds copied from root.

### Switching a wolf's runtime

**From the Mac (source of truth, provisions if needed):** flip `wolf_runtime`
in `inventory/hosts.yml`, then re-render + restart just the runtime layer:

```bash
ansible-playbook playbooks/redeploy.yml --limit forge
```

**On the host (fast flip between already-provisioned runtimes):**

```bash
wolfpack runtime              # list every wolf's current runtime
wolfpack runtime forge        # show one wolf's runtime
wolfpack runtime forge claude # switch — re-renders the unit + restarts
```

`wolfpack runtime` refuses to switch to a runtime that isn't installed on the
host and points you at the redeploy playbook — the CLI never half-provisions,
so Ansible stays the single source of truth for the unit template.

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
8. **`wolfpack-cli`** — Installs the `wolfpack` command, the `wolf-health` probe and bash completion into `/usr/local/bin` (see [The `wolfpack` command](#the-wolfpack-command)).

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
│   ├── templates/           # Note shapes the Templates plugin points at
│   ├── .obsidian/           # Vault config — the den opens as a real vault
│   └── .stignore            # vault UI state, .DS_Store, etc.
└── shared/                 # Pack library (receive-only from Mac)
    ├── skills/
    ├── templates/
    └── pack/
```

`wolf-service` runs `claude` with `WorkingDirectory=<the den>`, so Claude picks up `den/CLAUDE.md` as its main instruction file. Referencing `../shared/` in CLAUDE.md points it at the pack library.

### Two den locations

The first wolf on a host lives at `/home/wolf/workspace/den`, as above. Wolves added later by [`wolfpack add`](#the-wolfpack-command) each get their own directory instead:

```
/home/wolf/
├── workspace/
│   ├── den/                    # the first wolf
│   └── shared/                 # one pack library, shared by every wolf here
└── wolves/
    └── <name>/
        ├── den/                # same shape as above
        ├── claude/             # CLAUDE_CONFIG_DIR — its own token and plugins
        └── shared -> ../../workspace/shared
```

The split exists because the Telegram bot token lives in Claude's config directory, which is per-*user*. Two wolves running as the same user with one config directory would answer the same bot. Each added wolf therefore gets its own `CLAUDE_CONFIG_DIR` — and its own tmux server, so restarting one wolf cannot take down its packmates. `wolfpack den <wolf>` resolves either layout.

### How it syncs

Hub-and-spoke, always. Every folder is shared with the Mac and **never wolf-to-wolf** — the Mac is the only place the whole pack is visible at once. A folder that is not shared with the hub does not exist as far as you are concerned, however healthy it looks on the host.

There are exactly three classes of folder:

| Folder ID | On the host | On your Mac | Direction |
|---|---|---|---|
| `den-<wolf>` | that wolf's den | `~/Code/wolfpack/dens/<wolf>/` | bidirectional |
| `kb-<topic>` | `/home/wolf/knowledge/<topic>/` | `~/Code/wolfpack/knowledge/<topic>/` | bidirectional |
| `wolfpack-shared` | `/home/wolf/workspace/shared/` | `~/Code/wolfpack/shared/` | Mac sends, wolves receive |

Which gives you this on the Mac:

```
~/Code/wolfpack/
├── dens/<wolf>/        one vault per wolf — its memory, tasks, identity
├── knowledge/<topic>/  subject corpora, shared by one or more wolves
└── shared/             pack library, git-tracked, pushed to everyone
```

Open **`~/Code/wolfpack/` itself** as the Obsidian vault root, not an individual den. That is what makes `[[wikilinks]]` resolve across dens and knowledge — open `dens/hal/` alone and every link into a `kb-` corpus dangles.

**A `den-` folder is a wolf's private brain. A `kb-` folder is a subject.** A corpus that more than one wolf needs does not live inside a den; it gets its own `kb-` folder and is symlinked into each den that uses it, as `den/knowledge/<topic>`. Two consequences, both handled by `wolfpack sync`:

- Every den that symlinks a corpus **must** ignore that path. Syncthing does not follow symlinks, and without the ignore the den folder treats the corpus as deleted and propagates that delete to the Mac.
- `shared/` is the wrong home for a corpus a wolf should contribute to — it is receive-only on the host by design, so a wolf can read it but never write to it.

Wiring any of this is one command — see [`wolfpack sync`](#the-wolfpack-command). Folder IDs are immutable in Syncthing — renaming one means removing and re-adding the folder on both the host and the Mac, so the tooling matches on **path** rather than assuming a folder is named after the wolf that owns it.

### Viewing in Obsidian

Each den ships a `.obsidian/` config, so `~/Code/wolfpack/dens/<wolf>/` opens as a working vault with no setup: the Templates plugin points at the den's `templates/`, and daily notes are wired to `memory/daily/` using `templates/daily-log.md`. You can also open `~/Code/wolfpack/dens/` as one master vault treating each wolf as a subfolder.

The vault config syncs, but its UI state does not — `.stignore` drops `workspace.json` and the plugin caches, which would otherwise rewrite on every pane you move.

Assign a task by editing `dens/hal/tasks/inbox.md` in Obsidian. Syncthing pushes it to the wolf within seconds, and the wolf picks it up on its next session.

---

## The `wolfpack` command

Every host in the pack gets a single front door. Bare `wolfpack` lists what it can do:

```
wolfpack — pack control on wolf-01

  Usage: wolfpack <command> [wolf] [options]

  MONITOR
  health    [--watch|--json]  host CPU, memory, disk and per-wolf usage
  status                      service state, uptime and tmux liveness
  list                        wolves on this host and their unit names

  INSPECT
  launch                      pick a wolf from a menu and attach to it
  logs      [wolf] [lines]    tail journald logs for a wolf (default 50)
  attach    [wolf]            attach to the live Claude session
  den       [wolf]            print the path to a den

  CONTROL
  add       [name]            build a new wolf on this host — asks first
  sync      [wolf|--kb topic] wire a den or knowledge folder to the Mac hub
  restart   [wolf]            restart a wolf — asks you to confirm first
  rename    <old> <new>       rename a wolf everywhere on this host

  help                        this list
```

### Full command list

Every command, its aliases, and what actually runs. Commands marked **root**
re-exec themselves under `sudo` — you never need to type it.

| Command | Aliases | Arguments | Root | Does |
| --- | --- | --- | --- | --- |
| `wolfpack health` | `h` | `[--watch] [--json] [-i secs] [-n secs]` | soft | Host CPU/load/memory/swap/disk plus per-wolf cgroup usage. Runs unprivileged with `tmux` and den size degraded to `?`/`-`. |
| `wolfpack status` | `st` | — | no | One line per wolf: service state, tmux liveness, active-since timestamp. |
| `wolfpack list` | `ls` | — | no | Wolf names, their systemd unit, and unit state. |
| `wolfpack launch` | `pick` | — | yes | Numbered menu of the host's wolves, then attaches to the one you pick. |
| `wolfpack logs` | `log` | `[wolf] [lines]` | no | `journalctl` for that wolf's unit. Defaults to 50 lines. |
| `wolfpack attach` | `a` | `[wolf]` | yes | Attaches to the live Claude tmux session. |
| `wolfpack den` | — | `[wolf]` | no | Prints the den path, resolving both den layouts. |
| `wolfpack add` | `new` | `[name]` | yes | Builds another wolf on this host. Interactive; confirms before writing. |
| `wolfpack sync` | — | `[wolf]` \| `--kb <topic>` | yes | Wires a den or knowledge folder into Syncthing and shares it with the hub. Bare form is a read-only status table. |
| `wolfpack restart` | — | `[wolf]` | yes | Restarts a wolf. Requires typing its name. |
| `wolfpack rename` | — | `<old> <new>` | yes | Renames a wolf everywhere on this host. Requires typing its name. |
| `wolfpack help` | `-h`, `--help` | — | no | The command list. Also the default with no arguments. |

A bare flag goes to `health`, so `wolfpack --watch` and `wolfpack --json` work
directly. The wolf name may be omitted whenever the host has exactly one wolf;
with more than one, omitting it lists the candidates and exits non-zero.

**The scripts behind the commands.** `wolfpack` is a dispatcher — the work
lives in `scripts/`, installed by the `wolfpack-cli` role. Each is runnable on
its own if you need to debug one:

| Script | Installed as | Reached by |
| --- | --- | --- |
| `scripts/wolfpack` | `/usr/local/bin/wolfpack` | the command itself |
| `scripts/wolf-health.sh` | `/usr/local/bin/wolf-health` | `wolfpack health`, cc-bot `/health` |
| `scripts/add-wolf.sh` | stays in the repo | `wolfpack add` |
| `scripts/sync-wolf.sh` | stays in the repo | `wolfpack sync` |
| `scripts/rename-wolf.sh` | stays in the repo | `wolfpack rename` |

`add`, `sync` and `rename` read the repo at run time (`$WOLFPACK_REPO`,
default `/home/wolfpack/wolfpack`) because they render from the same `roles/`
templates Ansible uses. That host needs the repo checked out; the other three
commands do not.

The wolf name may be omitted whenever the host has exactly one wolf. Wolves are discovered from systemd — any unit whose Description is `Wolfpack - <name>` — so adding or renaming a wolf needs no change to the CLI, the completion, or the health probe. Bash completion is installed to `/etc/bash_completion.d/wolfpack` and completes both subcommands and live wolf names.

`wolfpack launch` is the interactive face of `attach` — for when you know you want a session but not which one. It lists the wolves on the host with their service state, waits for a number, and hands the choice to `attach`, so you get the same detach warning and the same `tmux attach`:

```
Wolves on wolf-01

  1) hal            active
  2) scout          inactive
  3) Quit

Choose a wolf [1-3]:
```

The list is printed once and the prompt sits under it — it uses a plain `read` loop rather than bash's `select`, which redraws the whole menu every time it re-prompts. Anything that isn't a valid number just re-asks. It refuses to run outside a terminal, and refuses to run from inside tmux — attaching there would nest one session in another. Pick the Quit entry (or Ctrl-d) to leave without attaching.

### `wolfpack add`

Builds another wolf on a host that is already a wolf host. `bootstrap.sh` makes the *host* — users, firewall, node, tailscale, syncthing — and then its first wolf; `add` does only that second half, so a second or third wolf costs one command instead of a full Ansible run.

It asks four things — name, what the wolf is for, Telegram, and whether to start it — shows a plan, and makes you type the name before it writes anything:

```
$ wolfpack add
  name: scout
  specialty [general assistant]: research and link triage
  set up Telegram for this wolf? [Y/n]: y
  bot token: 8012…
  your Telegram user id [7357687500]:
  start now? [Y/n]: y

Plan for 'scout' on wolf-01
  den            /home/wolf/wolves/scout/den
  claude config  /home/wolf/wolves/scout/claude
  service        /etc/systemd/system/scout.service
  …
Build it? [type 'scout' to continue]
```

Then it renders the den, seeds the config directory, writes the unit and starts it:

```
==> building den and config dir
    ✓ den:    /home/wolf/wolves/scout/den  (23 files)
    ✓ config: /home/wolf/wolves/scout/claude
    ✓ credentials and telegram plugin copied from /home/wolf/.claude
    ✓ telegram channel configured (owner 7357687500)
==> writing /etc/systemd/system/scout.service
==> starting scout
    ✓ service active
    ✓ tmux session up
    ✓ telegram bot up (pid 1634246)
```

Every file it writes is rendered from the same `roles/` templates Ansible uses — `roles/workspace/` for the den, `roles/wolf-service/templates/wolf.service.j2` for the unit — so there is no second copy of the den definition to drift. It needs the repo on the host (like `wolfpack rename`) and python3 with jinja2.

The new wolf's Claude config directory is seeded by copying the existing one: credentials, the installed Telegram plugin and its marketplace checkout, settings and hooks. That avoids a fresh OAuth login and plugin install per wolf. Only the bot token, the access list and the project trust differ. On a host with no wolf to copy from, it lays down what the repo has and tells you to run `claude auth login` against the new config dir.

**What it deliberately leaves alone**, because it reaches past the host — it prints the exact steps for each at the end:

- the Syncthing folder for the new den — run [`wolfpack sync <name>`](#wolfpack-sync) right after, then accept it on the Mac
- Tailscale (the wolf shares the host's tailnet identity)
- `inventory/hosts.yml` and `.env` on your Mac

`wolfpack restart` and `wolfpack rename` both refuse to act until you type the wolf's name, and both remind you to have the wolf checkpoint first — same protocol as the bot's `/restart` (see [How /restart interacts with wolves](cc-bot/README.md)).

### `wolfpack sync`

Syncthing is the one part of the pack that a host cannot finish on its own: a
folder has to be offered here *and* accepted on the Mac. `wolfpack sync` does
the whole host half and prints the exact Mac half.

Bare, it is a read-only status table — the fastest way to answer "is the Mac
actually seeing this?":

```
$ wolfpack sync
Hub  mac-hub  connected

FOLDER             TYPE          FILES     HUB  PATH
default            sendreceive       0    none  /home/wolf/Sync
den-hal            sendreceive     248    100%  /home/wolf/workspace/den
den-snapjack-bi    sendreceive      24    100%  /home/wolf/wolves/snapjack-bi/den
kb-snapjack        sendreceive      96    100%  /home/wolf/knowledge/snapjack
wolfpack-shared    receiveonly      12    100%  /home/wolf/workspace/shared

accept = offered to the Mac but not accepted there yet
```

The `HUB` column is the point of the whole table, and it distinguishes three
states that look identical in the Syncthing UI:

- **`100%`** — shared, accepted, and in sync.
- **`accept`** — offered to the Mac but never accepted there. Syncthing's own
  completion API reports 100% for this case, because a device that has been
  offered a folder it never took needs nothing it knows about; the table reads
  `remoteState` instead, which tells the truth.
- **`none`** — not shared with the hub at all. Invisible on the Mac no matter
  how healthy it looks here.

Two writing forms:

```
wolfpack sync <wolf>        # wire that wolf's den   → den-<wolf>
wolfpack sync --kb <topic>  # wire a knowledge folder → kb-<topic>
```

Both are idempotent: they repair drift rather than duplicating, and they never
change an existing folder's type or versioning. Wiring a den also scans it for
symlinked `kb-` folders and adds Syncthing ignores for them, so a knowledge
folder shared into three dens still syncs exactly once.

### Health output

```
🐺 WOLFPACK HEALTH  wolf-01  2026-08-30 08:33:48
  CPU       14.5%  [#---------]  2 vCPU
  Load      0.13   0.26 / 0.25 / 0.26  (1m per core)
  Memory    69.6%  [#######---]  1.3G / 1.9G   avail 600.8M
  Swap       5.7%  [#---------]  116.1M / 2.0G
  Disk /      18%  [##--------]  9.9G / 58.9G

WOLVES
  NAME           STATE         CPU        MEM   %HOST  TASKS RSTRT  TMUX   DEN
  hal            active       0.8%     409.3M   20.7%     40     2    up  2.4M
     ^ 2 unattended restart(s); peak mem 437.8M of 1.9G

SUPPORT (competing for the same 2 vCPU)
  syncthing@wolf active       0.0%      76.7M    3.9%     20
  tailscaled     active       0.0%      32.7M    1.7%     10
  wolfpack-cc    active       1.8%     287.4M   14.6%      6
```

Per-service CPU and memory come from cgroup v2 accounting (`CPUUsageNSec`, `MemoryCurrent`), so each figure covers the whole service tree — Claude, its subprocesses, and the tmux server — not a single PID. Support services are listed separately because on a 2 vCPU / 2 GB droplet they compete with the wolves for the same budget.

Two things the numbers alone would hide, so they are called out explicitly:

- **tmux liveness.** systemd can report `active` while the wolf's pane is gone. `TMUX: DOWN` is a critical condition even though the unit looks healthy.
- **Unattended restarts.** `Restart=always` means a wolf that crashed is silently back up, having lost its session. A non-zero `RSTRT` raises a warning until the counter is reset (`systemctl reset-failed <wolf>`).

### `--watch`

`wolfpack health --watch` refreshes every 5s (`-n <secs>` to change it). Each frame is rendered into a buffer while the previous one stays on screen, then swapped in — clearing first would leave the terminal blank for the whole ~1s CPU sampling window. It runs on the alternate screen with the cursor hidden, and on Ctrl-C it restores the terminal and reprints the last reading on the normal screen so the numbers survive quitting.

Frame cost is ~1.6s, of which 1.0s is the CPU sample window itself. Getting there meant two things worth remembering if you extend the probe: `systemctl show '*.service'` once instead of a `systemctl show` per unit (135 services on this host, ~2.3s versus ~0.3s), and one batched property read instead of one call per property per unit. Den sizes are `du`-based and cached for 60s (`DEN_TTL`).

Exit code is `0` healthy, `1` warning, `2` critical, so it drops straight into cron:

```
*/15 * * * * /usr/local/bin/wolf-health --json >> /var/log/wolf-health.jsonl || logger -t wolfpack "health check failed"
```

### Install

The `wolfpack-cli` role installs `/usr/local/bin/wolfpack`, `/usr/local/bin/wolf-health` and the completion, all `root:root 0755`. Root ownership is load-bearing rather than incidental: the cc-bot's sudoers drop-in lets the unprivileged `wolfpack` user run `wolf-health` as root (needed for the tmux probe and den sizing), and a target writable by that same user would turn the grant into a root escalation. Run unprivileged the probe still works, but tmux state shows `?` and den size shows `-`.

From Telegram, `/health` on the command-center bot returns the same reading.

---

## Adding a new wolf

**On a host that already runs one** — `wolfpack add`. See [`wolfpack add`](#wolfpack-add) above. One command, no Ansible run.

**On a new droplet**, the full path:

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
   - `wolfpack-shared` → `~/Code/wolfpack/shared` (Send Only, may already exist from hal)
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
│   │   ├── files/obsidian/               # Vault settings shipped into every den
│   │   └── templates/den/                # CLAUDE.md, SOUL.md, MEMORY.md templates
│   ├── syncthing/                        # Install + REST API folder config
│   ├── wolf-service/
│   │   ├── tasks/main.yml                # Deploy unit, smoke-test pane
│   │   ├── handlers/main.yml             # restart wolf handler
│   │   └── templates/wolf.service.j2     # systemd unit
│   ├── wolfpack-cli/                     # Install wolfpack + wolf-health + completion
│   └── cc-bot/                           # Command-center Telegram bot + sudoers
├── scripts/                              # Installed or invoked by the wolfpack CLI
│   ├── wolfpack                          # The `wolfpack` command (dispatcher)
│   ├── wolf-health.sh                    # Host + per-wolf health probe
│   ├── add-wolf.sh                       # Build another wolf on an existing host
│   ├── sync-wolf.sh                      # Wire a den or kb folder into Syncthing
│   └── rename-wolf.sh                    # Rename a wolf's live state on its host
├── cc-bot/                               # Bot source (TS + grammy + bun)
├── dens/                                 # gitignored; Mac-side wolf dens live here
├── knowledge/                            # gitignored; Mac-side kb-<topic> folders
└── shared/                               # git-tracked; pushed to every wolf
    ├── skills/
    ├── templates/
    └── pack/
```


### On a host

What the repo layout above turns into once two wolves are running:

```
/home/wolf/                                  the one Unix user every wolf shares
├── .claude/                                 hal's CLAUDE_CONFIG_DIR (the first wolf)
├── workspace/
│   ├── den/                                 hal's den            ← den-hal
│   └── shared/                              pack library         ← wolfpack-shared
├── knowledge/
│   └── snapjack/                            kb folder            ← kb-snapjack
└── wolves/
    └── snapjack-bi/
        ├── den/                             its den              ← den-snapjack-bi
        ├── claude/                          its CLAUDE_CONFIG_DIR (own bot token)
        └── shared/                          symlink → workspace/shared

/etc/systemd/system/
├── hal.service                              Description="Wolfpack - hal"
└── snapjack-bi.service                      Description="Wolfpack - snapjack-bi"

/usr/local/bin/
├── wolfpack                                 root:root 0755
└── wolf-health                              root:root 0755

/etc/bash_completion.d/wolfpack              subcommands + live wolf names
/home/wolfpack/wolfpack/                     this repo, read by add/sync/rename
```

Wolves are discovered from systemd — any unit whose `Description` is
`Wolfpack - <name>` — never from a list in a file. That is why adding or
renaming a wolf needs no edit to the CLI, the completion, or the health probe.
The first wolf on a host uses the default tmux socket; wolves from
`wolfpack add` get their own (`tmux -L <name>`) so their lifecycles are
independent.

---

## Security notes

- **No secrets in git.** `.env` is gitignored; credentials live in `keys/` (also gitignored).
- **No public internet exposure after Tailscale is up.** UFW allows SSH on public interfaces only until you firewall it off; `tailscale0` is the only interface Syncthing and other services listen on.
- **Telegram allowlist by default.** The `telegram` role writes an `access.json` that pre-allowlists only your owner ID (`owner_telegram_id` in inventory). Strangers DMing the bot get dropped silently.
- **Shared folder is receive-only on wolves.** A compromised wolf can't poison the shared skill library.
- **Claude runs as the unprivileged `wolf` user**, not root, with `sudo` access only if you configure it.
- **Per-wolf secrets live in `/etc/wolfpack/<wolf>.env`**, root-owned `0600`, loaded by that wolf's unit via `EnvironmentFile=`. systemd reads the file as PID 1 *before* dropping to the wolf user, so the wolf process inherits the values while the file itself stays unreadable to it — better than a dotfile in a home directory every wolf shares. The leading `-` on the `EnvironmentFile=` line makes it optional, so a wolf with no secrets still starts.
- **Every wolf on a host shares one Unix user, and therefore one `~/.ssh`.** The pack's SSH key authenticates to GitHub as you, so *any* wolf on the host inherits that access. Scope what you can with per-wolf tokens; do not assume one wolf is walled off from another's credentials. Real isolation would need one Unix user per wolf.
- **Git identity is set per-wolf in the unit** (`GIT_AUTHOR_NAME` and friends), because `~/.gitconfig` is per-user and shared — without it, one wolf's name lands on another's commits.

---

## License

Your own. Not affiliated with Anthropic.
