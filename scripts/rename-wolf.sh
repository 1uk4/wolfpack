#!/usr/bin/env bash
# rename-wolf.sh <old> <new> — rename a wolf on the host it runs on.
#
# The repo side (inventory, .env, README) is a normal edit. This handles the
# live state that Ansible will not fix on its own:
#   - systemd unit name + tmux session name
#   - the den's identity files (CLAUDE.md, config.yml) — edited in place,
#     because a live den drifts from roles/workspace/templates and re-running
#     that role would clobber the wolf's own edits
#   - Tailscale hostname
#   - the cc-bot sudoers drop-in, which names each wolf's unit explicitly
#
#   - the Syncthing folder *label*, which is what you read in the UI and in
#     `wolfpack sync`
#
# NOT touched: the Syncthing folder id (`den-<old>`). Folder ids are immutable
# in Syncthing, so changing it means removing and re-sharing the folder and
# re-accepting on the Mac — a coordinated two-sided operation, never done
# silently as part of a rename.
#
# This restarts the wolf, which ends its current session. Have the wolf write a
# checkpoint first (see "How /restart interacts with wolves" in cc-bot/README).

set -euo pipefail

OLD="${1:-}"; NEW="${2:-}"
WOLF_USER="${WOLF_USER:-wolf}"
DEN="/home/${WOLF_USER}/workspace/den"

if [ -z "$OLD" ] || [ -z "$NEW" ]; then
  echo "usage: $0 <old-name> <new-name>" >&2
  exit 64
fi
if ! printf '%s' "$NEW" | grep -qE '^[a-z][a-z0-9-]{1,30}$'; then
  echo "error: '$NEW' must be lowercase alphanumeric/dash — it becomes a systemd unit, tmux session and Tailscale hostname" >&2
  exit 64
fi
if [ "$(id -u)" != "0" ]; then
  echo "error: must run as root" >&2
  exit 1
fi
if [ ! -f "/etc/systemd/system/${OLD}.service" ]; then
  echo "error: /etc/systemd/system/${OLD}.service does not exist" >&2
  exit 1
fi
if [ -f "/etc/systemd/system/${NEW}.service" ]; then
  echo "error: /etc/systemd/system/${NEW}.service already exists" >&2
  exit 1
fi

tmux_sock() {   # name -> tmux socket args
  # Wolves from `wolfpack add` run their own tmux server so their lifecycles
  # are independent; the first wolf on a host is on the default socket.
  [ -d "/home/${WOLF_USER}/wolves/${1}" ] && printf -- '-L %s' "$1" || true
}

echo "Renaming wolf '${OLD}' -> '${NEW}' on $(hostname -s)"
printf 'This stops the running wolf. Checkpoint written? [type the new name to continue] '
read -r confirm
[ "$confirm" = "$NEW" ] || { echo "aborted"; exit 1; }

BACKUP="/var/lib/wolfpack/rename-${OLD}-to-${NEW}-$(date +%Y%m%d%H%M%S)"
mkdir -p "$BACKUP"
cp -a "/etc/systemd/system/${OLD}.service" "$BACKUP/" 2>/dev/null || true
cp -a "$DEN/CLAUDE.md" "$DEN/config.yml" "$BACKUP/" 2>/dev/null || true
cp -a /etc/sudoers.d/wolfpack-cc "$BACKUP/" 2>/dev/null || true
echo "  backup: $BACKUP"

echo "==> stopping ${OLD}"
systemctl disable --now "${OLD}.service"
sudo -iu "$WOLF_USER" tmux $(tmux_sock "$OLD") kill-session -t "$OLD" 2>/dev/null || true

echo "==> writing ${NEW}.service"
sed "s/\b${OLD}\b/${NEW}/g" "/etc/systemd/system/${OLD}.service" > "/etc/systemd/system/${NEW}.service"
chmod 0644 "/etc/systemd/system/${NEW}.service"
rm -f "/etc/systemd/system/${OLD}.service"
systemctl daemon-reload

OLD_CAP="$(printf '%s' "${OLD:0:1}" | tr '[:lower:]' '[:upper:]')${OLD:1}"
NEW_CAP="$(printf '%s' "${NEW:0:1}" | tr '[:lower:]' '[:upper:]')${NEW:1}"
rename_in() { sed -i "s/\b${OLD}\b/${NEW}/g; s/\b${OLD_CAP}\b/${NEW_CAP}/g" "$1"; }

echo "==> updating den identity"
for f in "$DEN/CLAUDE.md" "$DEN/config.yml"; do
  [ -f "$f" ] || continue
  rename_in "$f"
  chown "${WOLF_USER}:${WOLF_USER}" "$f"
done

# Paths that embed the wolf's name. These are the ones that fail *silently*:
# nothing errors, the wolf just stops being seen.
echo "==> migrating name-derived paths"

# The cc-bot reads /var/lib/wolfpack/health/<wolf>.json for /status. Miss this
# and /status reports "no health data yet" forever.
if [ -f "/var/lib/wolfpack/health/${OLD}.json" ]; then
  mv "/var/lib/wolfpack/health/${OLD}.json" "/var/lib/wolfpack/health/${NEW}.json"
  echo "  health file -> ${NEW}.json"
fi

if [ -f "/home/${WOLF_USER}/${OLD}-cron.log" ]; then
  mv "/home/${WOLF_USER}/${OLD}-cron.log" "/home/${WOLF_USER}/${NEW}-cron.log"
  echo "  cron log    -> ${NEW}-cron.log"
fi

# Holds live nag-suppression flags — moving the directory keeps them in force.
# Repointing the scripts without moving it would silently resume cancelled nags.
if [ -d "/home/${WOLF_USER}/.${OLD}-skip" ]; then
  mv "/home/${WOLF_USER}/.${OLD}-skip" "/home/${WOLF_USER}/.${NEW}-skip"
  echo "  skip flags  -> .${NEW}-skip ($(ls -1 "/home/${WOLF_USER}/.${NEW}-skip" | wc -l) flags preserved)"
fi

# skills/ holds prompts and docs that tell the wolf who it is, so they follow
# the rename. memory/, knowledge/, tasks/ and reports/ are the wolf's own
# record of what happened and are deliberately left alone.
if [ -d "$DEN/skills" ]; then
  n=0
  while IFS= read -r f; do
    rename_in "$f"; chown "${WOLF_USER}:${WOLF_USER}" "$f"; n=$((n+1))
  done < <(grep -rlI "\b${OLD}\b\|\b${OLD_CAP}\b" "$DEN/skills" 2>/dev/null)
  echo "  skills/     -> ${n} file(s) updated"
fi

echo "==> updating crontab for ${WOLF_USER}"
if crontab -u "$WOLF_USER" -l >"$BACKUP/crontab.bak" 2>/dev/null; then
  sed "s/\b${OLD}\b/${NEW}/g" "$BACKUP/crontab.bak" | crontab -u "$WOLF_USER" -
  echo "  crontab updated (backup in $BACKUP/crontab.bak)"
fi

if [ -f "/home/${WOLF_USER}/.gitconfig" ]; then
  rename_in "/home/${WOLF_USER}/.gitconfig"
fi

echo "==> updating cc-bot sudoers"
if [ -f /etc/sudoers.d/wolfpack-cc ]; then
  sed "s/\b${OLD}\.service\b/${NEW}.service/g" /etc/sudoers.d/wolfpack-cc > /tmp/wolfpack-cc.new
  if visudo -cf /tmp/wolfpack-cc.new >/dev/null; then
    install -m 0440 -o root -g root /tmp/wolfpack-cc.new /etc/sudoers.d/wolfpack-cc
  else
    echo "  !! generated sudoers failed validation, left unchanged" >&2
  fi
  rm -f /tmp/wolfpack-cc.new
fi

echo "==> updating Tailscale hostname"
tailscale set --hostname="$NEW" 2>/dev/null || tailscale up --hostname="$NEW" 2>/dev/null || \
  echo "  !! could not set Tailscale hostname; do it manually"

echo "==> starting ${NEW}"
systemctl enable --now "${NEW}.service"

echo "==> verifying"
for i in $(seq 1 24); do
  if sudo -iu "$WOLF_USER" tmux $(tmux_sock "$NEW") has-session -t "$NEW" 2>/dev/null; then break; fi
  sleep 5
done
systemctl is-active "${NEW}.service" >/dev/null \
  && echo "  service: active" || { echo "  !! service not active"; exit 1; }
sudo -iu "$WOLF_USER" tmux $(tmux_sock "$NEW") has-session -t "$NEW" 2>/dev/null \
  && echo "  tmux:    up" || echo "  !! tmux session '${NEW}' not up — check: journalctl -u ${NEW} -n 50"

LEFT=$(grep -rlI "\b${OLD}\b" "$DEN/memory" "$DEN/knowledge" 2>/dev/null | wc -l)

# The folder id is immutable but the label is not, and the label is what a human
# actually reads. Match on the den path, not the id — the id may still carry a
# name from an earlier rename.
echo "==> updating Syncthing folder label"
ST_CONFIG="/home/${WOLF_USER}/.local/state/syncthing/config.xml"
if [ -r "$ST_CONFIG" ]; then
  python3 - "$ST_CONFIG" "$DEN" "$NEW" <<'STPY'
import json, os, re, sys, urllib.request, urllib.error
cfg, den, new = sys.argv[1], sys.argv[2], sys.argv[3]
m = re.search(r"<apikey>([^<]+)</apikey>", open(cfg).read())
if not m:
    print("  ! could not read the API key - label left alone"); raise SystemExit(0)
API, KEY = "http://127.0.0.1:8384/rest", m.group(1)
def api(method, path, body=None):
    req = urllib.request.Request(API + path, method=method,
        headers={"X-API-Key": KEY, "Content-Type": "application/json"},
        data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=15) as r:
        raw = r.read(); return json.loads(raw) if raw else None
try:
    folders = api("GET", "/config/folders") or []
except (urllib.error.URLError, OSError) as e:
    print(f"  ! Syncthing API unreachable ({e}) - label left alone"); raise SystemExit(0)
hit = next((f for f in folders if os.path.realpath(f["path"]) == os.path.realpath(den)), None)
if not hit:
    print("  ! no Syncthing folder for this den - nothing to relabel"); raise SystemExit(0)
want = f"{new}-den"
if hit["label"] == want:
    print(f"  label already {want}")
else:
    was = hit["label"]; hit["label"] = want
    api("PUT", f"/config/folders/{hit['id']}", hit)
    print(f"  label {was} -> {want} (folder id stays '{hit['id']}')")
STPY
else
  echo "  ! no Syncthing config for ${WOLF_USER} - skipped"
fi

cat <<MSG

Done on this host.

The wolf's own record (den/memory, den/knowledge) still mentions '${OLD}' in
${LEFT} file(s). That is history, not identity, so it was left as written.

Still manual:
  - .env on your Mac: TELEGRAM_BOT_TOKEN_${OLD^^} -> TELEGRAM_BOT_TOKEN_${NEW^^}
  - @BotFather: rename the bot's display name (the token itself is unchanged)
  - Syncthing folder id is still 'den-${OLD}' - immutable. The label now reads
    '${NEW}-den'; changing the id needs a remove/re-add on both ends.
  - Mac den folder: mv ~/Code/wolfpack/dens/${OLD} ~/Code/wolfpack/dens/${NEW}
    (do this with Syncthing paused, then repoint the folder path)
MSG
