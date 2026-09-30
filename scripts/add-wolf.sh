#!/usr/bin/env bash
# add-wolf.sh [name] — build a new wolf on the host it runs on.
#
# Ansible's bootstrap.yml builds the FIRST wolf on a fresh droplet: it makes
# the host (users, firewall, node, tailscale, syncthing) and then the wolf.
# This script does only the second half, for a host that is already a wolf
# host, so you can add a second, third, fourth wolf without a full run.
#
# Layout. The first wolf lives at /home/<user>/workspace/den with its Claude
# config in /home/<user>/.claude. That is one wolf per host: the Telegram bot
# token lives in the config dir, which is per-USER, so two wolves sharing a
# user would share a bot. Wolves added by this script therefore get their own:
#
#   /home/<user>/wolves/<name>/den      the Obsidian vault, synced to the Mac
#   /home/<user>/wolves/<name>/claude   CLAUDE_CONFIG_DIR — token, plugins, creds
#   /home/<user>/wolves/<name>/shared   symlink to the shared pack library
#
# Same user, so one tmux server (sessions stay addressable as `tmux attach -t
# <name>`) and one Syncthing instance. The unit file gets CLAUDE_CONFIG_DIR so
# each wolf reads its own token.
#
# Everything it writes is rendered from the same roles/ templates Ansible uses.
# There is no second copy of the den definition to drift.
#
# NOT done here (deliberate — these reach beyond this host):
#   - Syncthing folder for the new den, and accepting it on the Mac
#   - Tailscale
#   - inventory/hosts.yml and .env on the Mac
# The script prints exactly what to add for each.

set -euo pipefail

WOLF_USER="${WOLF_USER:-wolf}"
REPO="${WOLFPACK_REPO:-/home/wolfpack/wolfpack}"
USER_HOME="/home/${WOLF_USER}"
WOLVES_ROOT="${USER_HOME}/wolves"
SHARED_DIR="${USER_HOME}/workspace/shared"
SEED_CFG="${USER_HOME}/.claude"

if [ -t 1 ]; then
  B=$'\e[1m'; DIM=$'\e[2m'; R=$'\e[0m'; RED=$'\e[31m'; GRN=$'\e[32m'; YEL=$'\e[33m'; CYA=$'\e[36m'
else
  B=""; DIM=""; R=""; RED=""; GRN=""; YEL=""; CYA=""
fi

die()  { printf '%serror:%s %s\n' "$RED" "$R" "$*" >&2; exit 1; }
step() { printf '%s==>%s %s\n' "$CYA" "$R" "$*"; }
ok()   { printf '    %s✓%s %s\n' "$GRN" "$R" "$*"; }
warn() { printf '    %s!%s %s\n' "$YEL" "$R" "$*"; }

tmux_sock() {   # name -> tmux socket args
  # Wolves from `wolfpack add` run their own tmux server so their lifecycles
  # are independent; the first wolf on a host is on the default socket.
  [ -d "/home/${WOLF_USER}/wolves/${1}" ] && printf -- '-L %s' "$1" || true
}

###############################################################################
# Preflight
###############################################################################
[ "$(id -u)" = "0" ] || die "must run as root"
[ -t 0 ] || die "add needs a terminal — it asks questions"

id "$WOLF_USER" >/dev/null 2>&1 || die "user '$WOLF_USER' does not exist (this host has never been bootstrapped)"
[ -d "$REPO/roles/workspace" ] || die "wolfpack repo not found at $REPO (set WOLFPACK_REPO)"
command -v tmux    >/dev/null || die "tmux not installed"
command -v claude  >/dev/null || die "claude not installed"
command -v python3 >/dev/null || die "python3 not installed"
python3 -c "import jinja2" 2>/dev/null || die "python3 jinja2 missing — the den is rendered from the same templates Ansible uses (apt install python3-jinja2)"

###############################################################################
# Name
###############################################################################
NAME="${1:-}"
while true; do
  if [ -z "$NAME" ]; then
    printf '\n%sName the wolf.%s %slowercase, becomes its systemd unit, tmux session and den path%s\n' \
      "$B" "$R" "$DIM" "$R"
    read -rp "  name: " NAME || die "input ended — nothing was created"
  fi
  if ! printf '%s' "$NAME" | grep -qE '^[a-z][a-z0-9-]{1,30}$'; then
    printf '  %sname must be lowercase letters, digits and dashes, starting with a letter%s\n' "$RED" "$R"
    NAME=""; continue
  fi
  if [ -f "/etc/systemd/system/${NAME}.service" ]; then
    printf '  %s'\''%s'\'' already has a systemd unit on this host%s\n' "$RED" "$NAME" "$R"
    NAME=""; continue
  fi
  if [ -e "${WOLVES_ROOT}/${NAME}" ]; then
    printf '  %s%s/%s already exists%s\n' "$RED" "$WOLVES_ROOT" "$NAME" "$R"
    NAME=""; continue
  fi
  if sudo -iu "$WOLF_USER" tmux has-session -t "$NAME" </dev/null 2>/dev/null \
     || sudo -iu "$WOLF_USER" tmux -L "$NAME" has-session -t "$NAME" </dev/null 2>/dev/null; then
    printf '  %sa tmux session named '\''%s'\'' is already running%s\n' "$RED" "$NAME" "$R"
    NAME=""; continue
  fi
  break
done

DEN="${WOLVES_ROOT}/${NAME}/den"
CFG="${WOLVES_ROOT}/${NAME}/claude"

###############################################################################
# Questions
###############################################################################
printf '\n%sWhat is this wolf for?%s %sone line, goes in config.yml and its CLAUDE.md%s\n' \
  "$B" "$R" "$DIM" "$R"
read -rp "  specialty [general assistant]: " SPECIALTY || true
SPECIALTY="${SPECIALTY:-general assistant}"

# Owner id: reuse the one an existing wolf is already paired with, so the
# common case is a keypress. It is the Telegram user allowed to DM the bot.
OWNER_DEFAULT=""
for a in "$SEED_CFG/channels/telegram/access.json" "$WOLVES_ROOT"/*/claude/channels/telegram/access.json; do
  [ -f "$a" ] || continue
  OWNER_DEFAULT=$(python3 -c "
import json,sys
try:
    print((json.load(open(sys.argv[1])).get('allowFrom') or [''])[0])
except Exception:
    print('')
" "$a" 2>/dev/null) || OWNER_DEFAULT=""
  [ -n "$OWNER_DEFAULT" ] && break
done

printf '\n%sTelegram.%s %sthe wolf listens on one bot; without it there is no way to DM it%s\n' \
  "$B" "$R" "$DIM" "$R"
read -rp "  set up Telegram for this wolf? [Y/n]: " TG_ANS || true
TG_ANS="${TG_ANS:-y}"
TELEGRAM=no
BOT_TOKEN=""
OWNER_ID=""
case "$TG_ANS" in
  [Yy]*)
    TELEGRAM=yes
    printf '  %sDM @BotFather → /newbot → copy the token it gives you.%s\n' "$DIM" "$R"
    while true; do
      read -rp "  bot token: " BOT_TOKEN || die "input ended — nothing was created"
      printf '%s' "$BOT_TOKEN" | grep -qE '^[0-9]{6,}:[A-Za-z0-9_-]{30,}$' && break
      printf '  %sthat does not look like a bot token (digits, colon, then ~35 chars)%s\n' "$RED" "$R"
    done
    while true; do
      if [ -n "$OWNER_DEFAULT" ]; then
        read -rp "  your Telegram user id [$OWNER_DEFAULT]: " OWNER_ID || die "input ended — nothing was created"
        OWNER_ID="${OWNER_ID:-$OWNER_DEFAULT}"
      else
        printf '  %sDM @userinfobot to find yours.%s\n' "$DIM" "$R"
        read -rp "  your Telegram user id: " OWNER_ID || die "input ended — nothing was created"
      fi
      printf '%s' "$OWNER_ID" | grep -qE '^[0-9]{5,}$' && break
      printf '  %sa Telegram user id is all digits%s\n' "$RED" "$R"
    done
    ;;
esac

printf '\n%sStart it when the files are in place?%s %sno = build only, start later with systemctl%s\n' \
  "$B" "$R" "$DIM" "$R"
read -rp "  start now? [Y/n]: " START_ANS || true
START_ANS="${START_ANS:-y}"
case "$START_ANS" in [Yy]*) START=yes ;; *) START=no ;; esac

###############################################################################
# Plan + confirm
###############################################################################
TS_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
HOST_SHORT="$(hostname -s)"

cat <<PLAN

${B}Plan for '${NAME}' on ${HOST_SHORT}${R}

  den            ${DEN}
                 ${DIM}Obsidian vault — CLAUDE.md, SOUL.md, memory/, tasks/,
                 knowledge/, reports/, templates/, .obsidian/${R}
  claude config  ${CFG}
                 ${DIM}CLAUDE_CONFIG_DIR — its own bot token and plugins${R}
  shared         ${WOLVES_ROOT}/${NAME}/shared -> ${SHARED_DIR}
  service        /etc/systemd/system/${NAME}.service
  specialty      ${SPECIALTY}
  telegram       $( [ "$TELEGRAM" = yes ] && printf 'yes — token ...%s, owner %s' "${BOT_TOKEN: -6}" "$OWNER_ID" || printf 'no' )
  start now      ${START}

  ${DIM}Nothing existing is modified. Syncthing, Tailscale and the Mac-side
  inventory are left alone — the steps for those print at the end.${R}

PLAN
# A key pressed before the plan was on screen must not answer for it: a stray
# newline left in the terminal buffer by an earlier prompt used to land here as
# an instant "aborted". Drop anything already buffered, then ask on /dev/tty,
# and re-ask rather than exiting when the answer is not the name.
exec 3</dev/tty 2>/dev/null || exec 3<&0
while IFS= read -r -t 0.05 -u 3 _junk; do :; done
while true; do
  printf "Build it? [type '%s' to continue, n to cancel] " "$NAME"
  read -r confirm <&3 || { echo; echo "aborted"; exit 1; }
  case "$confirm" in
    "$NAME")                  break ;;
    [Nn]|[Nn][Oo]|q|quit)     echo "aborted"; exit 1 ;;
    "")  printf "  %stype the name '%s' to build it, or n to cancel%s\n" "$DIM" "$NAME" "$R" ;;
    *)   printf "  %sthat is not '%s' — type the name exactly, or n to cancel%s\n" "$DIM" "$NAME" "$R" ;;
  esac
done
exec 3<&-
echo

###############################################################################
# Scaffold
###############################################################################
step "building den and config dir"

# The env prefix has to live inside the substitution, or these become plain
# shell assignments and python never sees them.
SCAFFOLD=$(
WOLF_NAME="$NAME" \
WOLF_USER="$WOLF_USER" \
WOLF_DEN="$DEN" \
WOLF_CFG="$CFG" \
WOLF_SHARED="$SHARED_DIR" \
WOLF_SEED_CFG="$SEED_CFG" \
WOLF_REPO="$REPO" \
WOLF_SPECIALTY="$SPECIALTY" \
WOLF_TELEGRAM="$TELEGRAM" \
WOLF_BOT_TOKEN="$BOT_TOKEN" \
WOLF_OWNER_ID="${OWNER_ID:-$OWNER_DEFAULT}" \
WOLF_HOST="$HOST_SHORT" \
WOLF_TS_IP="$TS_IP" \
python3 - <<'PY'
import json, os, pwd, shutil
from pathlib import Path
import jinja2

E        = os.environ
name     = E["WOLF_NAME"]
user     = E["WOLF_USER"]
den      = Path(E["WOLF_DEN"])
cfg      = Path(E["WOLF_CFG"])
shared   = Path(E["WOLF_SHARED"])
seed     = Path(E["WOLF_SEED_CFG"])
repo     = Path(E["WOLF_REPO"])
telegram = E["WOLF_TELEGRAM"] == "yes"

pw  = pwd.getpwnam(user)
UID, GID = pw.pw_uid, pw.pw_gid

def own(p):
    os.chown(p, UID, GID)

def own_tree(root):
    own(root)
    for d, dirs, files in os.walk(root):
        for n in dirs + files:
            p = os.path.join(d, n)
            if not os.path.islink(p):
                own(p)

def mkdir(p, mode=0o755):
    p.mkdir(parents=True, exist_ok=True)
    p.chmod(mode)
    own(p)

def render(src, dest, **vars):
    tpl = jinja2.Template(src.read_text(), trim_blocks=True, keep_trailing_newline=True)
    dest.write_text(tpl.render(**vars))
    own(dest)

def copy(src, dest, mode=None):
    shutil.copyfile(src, dest)
    if mode is not None:
        dest.chmod(mode)
    own(dest)

created = []

# ---------------------------------------------------------------- den -------
for sub in ("", "memory", "memory/daily", "memory/checkpoints",
            "tasks", "knowledge", "reports", "templates", ".obsidian"):
    mkdir(den / sub if sub else den)

# mkdir(parents=True) made wolves/ and wolves/<name>/ as root; the wolf has to
# own its whole tree or Syncthing and the agent itself cannot write in it.
for d in (den.parent.parent, den.parent):
    own(d)

ws = repo / "roles" / "workspace"

# The two identity files are the same Jinja templates the Ansible role uses.
# ansible_host/inventory_hostname are what those templates expect to be given.
tvars = dict(
    wolf_name          = name,
    wolf_user          = user,
    owner_telegram_id  = E["WOLF_OWNER_ID"] or "",
    inventory_hostname = E["WOLF_HOST"],
    ansible_host       = E["WOLF_TS_IP"] or E["WOLF_HOST"],
)
render(ws / "templates" / "CLAUDE.md.j2", den / "CLAUDE.md", **tvars)
render(ws / "templates" / "config.yml.j2", den / "config.yml", **tvars)
created += ["CLAUDE.md", "config.yml"]

# config.yml's specialty is the one answer with no template variable behind it.
cy = (den / "config.yml").read_text()
cy = cy.replace('specialty: "general assistant"', 'specialty: "%s"' % E["WOLF_SPECIALTY"])
(den / "config.yml").write_text(cy)

for src, dst in [
    ("SOUL.md",      "SOUL.md"),
    ("MEMORY.md",    "MEMORY.md"),
    ("HEARTBEAT.md", "HEARTBEAT.md"),
    ("human.md",     "memory/human.md"),
    ("decisions.md", "memory/decisions.md"),
    ("lessons.md",   "memory/lessons.md"),
    ("errors.md",    "memory/errors.md"),
    ("inbox.md",     "tasks/inbox.md"),
    ("active.md",    "tasks/active.md"),
    ("done.md",      "tasks/done.md"),
]:
    copy(ws / "files" / src, den / dst)
    created.append(dst)

for t in ("checkpoint.md", "daily-log.md", "decision.md",
          "knowledge-note.md", "task-report.md"):
    copy(repo / "shared" / "templates" / t, den / "templates" / t)
    created.append("templates/" + t)

for o in ("app.json", "appearance.json", "core-plugins.json",
          "templates.json", "daily-notes.json"):
    copy(ws / "files" / "obsidian" / o, den / ".obsidian" / o)
    created.append(".obsidian/" + o)

copy(ws / "files" / "stignore", den / ".stignore")
created.append(".stignore")

# CLAUDE.md says skills live at ../shared/. In the per-wolf layout that is one
# level up from the den, so point it at the single shared library on the host.
link = den.parent / "shared"
if not link.exists():
    link.symlink_to(shared)
    os.lchown(link, UID, GID)

print("DEN_FILES=%d" % len(created))

# ------------------------------------------------------------- config -------
mkdir(cfg, 0o700)

seeded_from_existing = (seed / ".credentials.json").exists()

if seeded_from_existing:
    # Copy the working config wholesale: credentials, the installed telegram
    # plugin and its marketplace checkout. Building those from scratch would
    # mean a fresh OAuth login and a plugin install per wolf.
    copy(seed / ".credentials.json", cfg / ".credentials.json", 0o600)
    for d in ("plugins", "hooks"):
        if (seed / d).is_dir():
            shutil.copytree(seed / d, cfg / d, dirs_exist_ok=True, symlinks=True)
            own_tree(cfg / d)
    if (seed / "settings.json").exists():
        s = (seed / "settings.json").read_text()
        # hooks are referenced by absolute path and must follow this wolf
        s = s.replace("$HOME/.claude/hooks/", str(cfg / "hooks") + "/")
        (cfg / "settings.json").write_text(s)
        (cfg / "settings.json").chmod(0o600)
        own(cfg / "settings.json")
else:
    # Fresh host with no wolf to copy from: lay down what the repo has and let
    # the operator finish the login.
    mkdir(cfg / "hooks", 0o700)
    copy(repo / "roles" / "claude-code" / "files" / "settings.json",
         cfg / "settings.json", 0o600)

# The Stop hook writes the daily log; it resolves the den from
# CLAUDE_PROJECT_DIR, so one copy per wolf works unmodified.
hook = repo / "roles" / "claude-code" / "files" / "hooks" / "session-end-journal.sh"
mkdir(cfg / "hooks", 0o700)
copy(hook, cfg / "hooks" / "session-end-journal.sh", 0o755)

# .claude.json carries the onboarding flags that keep a headless session from
# stopping on a first-run prompt. Per-project state is the previous wolf's and
# is dropped; the new den is pre-trusted so the trust dialog never appears.
base = {}
seed_json = seed.parent / ".claude.json"
if seed_json.exists():
    try:
        base = json.loads(seed_json.read_text())
    except Exception:
        base = {}
for k in ("projects", "history", "skillUsage", "pluginUsage"):
    base.pop(k, None)
base["hasCompletedOnboarding"] = True
base["projects"] = {str(den): {"hasTrustDialogAccepted": True}}
(cfg / ".claude.json").write_text(json.dumps(base, indent=2))
(cfg / ".claude.json").chmod(0o600)
own(cfg / ".claude.json")

# ----------------------------------------------------------- telegram -------
if telegram:
    ch = cfg / "channels" / "telegram"
    mkdir(ch, 0o700)
    own(cfg / "channels")
    (ch / ".env").write_text("TELEGRAM_BOT_TOKEN=%s" % E["WOLF_BOT_TOKEN"])
    (ch / ".env").chmod(0o600); own(ch / ".env")
    (ch / "access.json").write_text(json.dumps({
        "dmPolicy": "allowlist",
        "allowFrom": [E["WOLF_OWNER_ID"]],
        "groups": {},
        "pending": {},
    }, indent=2))
    (ch / "access.json").chmod(0o600); own(ch / "access.json")
    mkdir(ch / "approved")
    (ch / "approved" / E["WOLF_OWNER_ID"]).write_text(E["WOLF_OWNER_ID"])
    own(ch / "approved" / E["WOLF_OWNER_ID"])

own_tree(den)
print("SEEDED_FROM_EXISTING=%s" % ("yes" if seeded_from_existing else "no"))
PY
)

DEN_FILES=$(printf '%s\n' "$SCAFFOLD" | sed -n 's/^DEN_FILES=//p')
ok "den:    $DEN  (${DEN_FILES:-?} files)"
ok "config: $CFG"
printf '%s\n' "$SCAFFOLD" | grep -q '^SEEDED_FROM_EXISTING=yes' \
  && ok "credentials and telegram plugin copied from $SEED_CFG"
[ "$TELEGRAM" = yes ] && ok "telegram channel configured (owner $OWNER_ID)"

if [ ! -f "$CFG/.credentials.json" ]; then
  warn "no Claude credentials to copy from $SEED_CFG"
  warn "run:  sudo -iu $WOLF_USER CLAUDE_CONFIG_DIR=$CFG claude auth login"
fi

###############################################################################
# systemd unit
###############################################################################
step "writing /etc/systemd/system/${NAME}.service"

UNIT_SRC="$REPO/roles/wolf-service/templates/wolf.service.j2"
[ -f "$UNIT_SRC" ] || die "unit template not found at $UNIT_SRC"

# A wolf with no Telegram config must not be launched with a channel listener.
if [ "$TELEGRAM" = yes ]; then
  CLAUDE_ARGS="--channels plugin:telegram@claude-plugins-official"
else
  CLAUDE_ARGS=""
fi

WOLF_NAME="$NAME" WOLF_USER="$WOLF_USER" WOLF_DEN="$DEN" WOLF_CFG="$CFG" \
WOLF_UNIT_SRC="$UNIT_SRC" WOLF_CLAUDE_ARGS="$CLAUDE_ARGS" \
python3 - > "/etc/systemd/system/${NAME}.service" <<'PY'
import os, jinja2
E = os.environ
src = open(E["WOLF_UNIT_SRC"]).read()
print(jinja2.Template(src, trim_blocks=True).render(
    wolf_name       = E["WOLF_NAME"],
    wolf_user       = E["WOLF_USER"],
    wolf_den        = E["WOLF_DEN"],
    wolf_config_dir = E["WOLF_CFG"],
    wolf_claude_args = E["WOLF_CLAUDE_ARGS"],
))
PY
chmod 0644 "/etc/systemd/system/${NAME}.service"
systemctl daemon-reload
ok "unit written (WorkingDirectory=$DEN, CLAUDE_CONFIG_DIR=$CFG)"

###############################################################################
# Start
###############################################################################
if [ "$START" = yes ]; then
  step "starting ${NAME}"
  systemctl enable --now "${NAME}.service"

  for _ in $(seq 1 24); do
    sudo -iu "$WOLF_USER" tmux $(tmux_sock "$NAME") has-session -t "$NAME" </dev/null 2>/dev/null && break
    sleep 5
  done

  if systemctl is-active "${NAME}.service" >/dev/null; then
    ok "service active"
  else
    warn "service is not active — journalctl -u ${NAME} -n 50"
  fi

  if sudo -iu "$WOLF_USER" tmux $(tmux_sock "$NAME") has-session -t "$NAME" </dev/null 2>/dev/null; then
    ok "tmux session up"
  else
    warn "tmux session '${NAME}' not up — wolfpack logs ${NAME}"
  fi

  if [ "$TELEGRAM" = yes ]; then
    # Readiness is the bot process, not a banner. Claude Code renders the
    # channel state inside /status ("Listening for messages from ...") and
    # never prints it to the pane, so capture-pane can never see it — and a
    # full-screen TUI keeps no scrollback to search anyway. The telegram
    # plugin writes channels/telegram/bot.pid when its server is up; that
    # file plus a live PID is the signal.
    BOT_PID_FILE="$CFG/channels/telegram/bot.pid"
    printf '    %swaiting for the telegram bot to come up%s' "$DIM" "$R"
    LISTENING=no
    for _ in $(seq 1 24); do
      BOT_PID=$(cat "$BOT_PID_FILE" 2>/dev/null || true)
      if [ -n "$BOT_PID" ] && kill -0 "$BOT_PID" 2>/dev/null; then
        LISTENING=yes; break
      fi
      printf '.'; sleep 5
    done
    printf '\n'
    [ "$LISTENING" = yes ] && ok "telegram bot up (pid $BOT_PID)" \
      || warn "no live bot pid in $BOT_PID_FILE — wolfpack attach ${NAME} and run /status"
  fi
else
  step "not started (you chose build-only)"
  printf '    start it with:  systemctl enable --now %s\n' "$NAME"
fi

###############################################################################
# What is left
###############################################################################
# Dashes are legal in a wolf name but not in a shell/ansible env var name,
# so 'snapjack-bi' has to become TELEGRAM_BOT_TOKEN_SNAPJACK_BI.
UPPER=$(printf '%s' "$NAME" | tr 'a-z-' 'A-Z_')
cat <<DONE

${B}${NAME} is built.${R}  ${DIM}wolfpack status${R}

${B}Still to do — these reach past this host:${R}

  ${CYA}1. Syncthing${R}  the den is not syncing to your Mac yet.
       wolfpack sync ${NAME}
     That creates den-${NAME} here, ignores any shared kb-* corpora the den
     symlinks, and prints exactly what to accept on the Mac.

  ${CYA}2. The Mac's repo${R}  so a future ansible run knows about this wolf.
     inventory/hosts.yml, under the same host as its packmates:
       wolf_name: ${NAME}
       telegram_bot_token: "{{ lookup('env', 'TELEGRAM_BOT_TOKEN_${UPPER}') }}"
     .env:
       TELEGRAM_BOT_TOKEN_${UPPER}=<the token you just pasted>

  ${CYA}3. Tailscale${R}  not touched — this wolf shares the host's tailnet identity.

$( [ "$TELEGRAM" = yes ] && printf '  %s4. DM the bot%s to check it answers. Only %s can talk to it.\n' "$CYA" "$R" "$OWNER_ID" )
DONE
