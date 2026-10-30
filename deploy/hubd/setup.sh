#!/usr/bin/env bash
# Idempotent hubd setup/install for sfo-01. Run as root ON the host, after the owner confirms.
#   setup.sh [--dry-run] setup    [--bind IP] [--port N] [--wolf NAME]... [--hub-writes]
#   setup.sh [--dry-run] install  --bundle <dir with hubd.mjs, RUNBOOK.md, VERSION>
#   setup.sh [--dry-run] rollback
#   setup.sh [--dry-run] uninstall [--purge]
# --dry-run prints every state-changing action ("DRY-RUN: ...") and changes nothing; read-only probes still run.
# No ACLs and no changes to Dewey's dirs except creating missing per-wolf lane dirs (owner wolf-W1hOrJ, mode 777).
set -euo pipefail

DRY=0 CMD="" BUNDLE="" BIND="" PORT=3150 HUB_WRITES=0 PURGE=0
WOLVES=()
HUBD_USER=hubd
HUBD_GROUP=hubd
WOLF_USER=wolf-W1hOrJ
WOLF_HOME=/home/wolf-W1hOrJ
DOMAINS=$WOLF_HOME/knowledge/base/domains
INBOX=$WOLF_HOME/librarian/inbox
RECEIPTS=$WOLF_HOME/librarian/receipts
DATA_DIR=/var/lib/hubd
OPT=/opt/wolfpack-hubd
ENV_DIR=/etc/wolfpack
ENV_FILE=$ENV_DIR/hubd.env
UNIT=/etc/systemd/system/hubd.service
DROPIN_DIR=/etc/systemd/system/hubd.service.d
KEEP_RELEASES=5
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "setup.sh: $*" >&2; exit 1; }
log() { echo "==> $*"; }
warn() { echo "WARNING: $*" >&2; }
run() { if ((DRY)); then printf 'DRY-RUN:'; printf ' %q' "$@"; printf '\n'; else "$@"; fi; }
# A check that must pass. In a dry run a failure is reported as "WOULD FAIL" and the run continues.
need() { # need <message> <command...>
  local msg=$1; shift
  if "$@"; then return 0; fi
  if ((DRY)); then echo "WOULD FAIL: $msg"; else die "$msg"; fi
}
as_hubd() { runuser -u "$HUBD_USER" -- "$@"; }
valid_ipv4() {
  [[ $1 =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  ((10#${BASH_REMATCH[1]} <= 255 && 10#${BASH_REMATCH[2]} <= 255 && 10#${BASH_REMATCH[3]} <= 255 && 10#${BASH_REMATCH[4]} <= 255))
}
valid_port() { [[ $1 =~ ^[0-9]+$ ]] && ((10#$1 >= 1024 && 10#$1 <= 65535 && 10#$1 != 3141)); }
valid_wolf() { [[ $1 =~ ^[a-z0-9][a-z0-9-]*$ ]]; }

while (($#)); do
  case "$1" in
    --dry-run) DRY=1 ;;
    --bundle) BUNDLE="${2:?--bundle needs a dir}"; shift ;;
    --bind) BIND="${2:?--bind needs an IP}"; shift ;;
    --port) PORT="${2:?--port needs a number}"; shift ;;
    --wolf) valid_wolf "${2:?--wolf needs a name}" || die "bad wolf name $2"; WOLVES+=("$2"); shift ;;
    --hub-writes) HUB_WRITES=1 ;;
    --purge) PURGE=1 ;;
    setup | install | rollback | uninstall) CMD="$1" ;;
    *) die "unknown argument $1" ;;
  esac
  shift
done
[[ -n $CMD ]] || die "usage: setup.sh [--dry-run] setup|install|rollback|uninstall [options]"
valid_port "$PORT" || die "bad --port $PORT (1024-65535, and never 3141: wolfpack-agent)"
((${#WOLVES[@]})) || WOLVES=(1uk4)
((DRY)) || [[ $EUID -eq 0 ]] || die "run as root (or use --dry-run)"

hasuser() { id "$1" >/dev/null 2>&1; }
hubd_user_exists() { id "$HUBD_USER" >/dev/null 2>&1; }

# Is the given TCP port bound by something other than our own hubd? Prints the offending line.
port_foreign_listener() {
  local line pid main
  line="$(ss -ltnpH 2>/dev/null | awk -v p=":$1" '$4 ~ p"$" {print; exit}')" || true
  [[ -n $line ]] || return 1
  pid="$(sed -n 's/.*pid=\([0-9]*\).*/\1/p' <<<"$line" | head -n1)"
  main="$(systemctl show -p MainPID --value hubd 2>/dev/null || echo 0)"
  if [[ -n $pid && $pid == "$main" && $main != 0 ]]; then return 1; fi
  echo "$line"
}

# Read-only access checks as the hubd user. Needs the user to exist.
access_checks() {
  local d w
  if ! hubd_user_exists; then
    echo "NOTE: user $HUBD_USER does not exist yet; the access checks run (as $HUBD_USER) once it is created"
    return 0
  fi
  need "$DOMAINS is not readable by $HUBD_USER" as_hubd test -r "$DOMAINS" -a -x "$DOMAINS"
  local bad
  bad="$(as_hubd find -L "$DOMAINS" ! -readable 2>/dev/null | head -n 20 || true)"
  [[ -z $bad ]] || warn "files/dirs under domains/ unreadable by $HUBD_USER (first 20):"$'\n'"$bad"
  for d in "$INBOX" "$RECEIPTS"; do
    need "$d is not writable by $HUBD_USER" as_hubd test -d "$d" -a -w "$d" -a -x "$d"
    for w in "${WOLVES[@]}"; do
      if [[ -d $d/$w ]]; then need "$d/$w is not writable by $HUBD_USER" as_hubd test -w "$d/$w" -a -x "$d/$w"; fi
    done
  done
}

cmd_setup() {
  local node d w
  log "preflight (read-only)"
  node="$(command -v node || true)"
  [[ $node == /usr/bin/node || $node == /usr/local/bin/node ]] || need "node must be in /usr/bin or /usr/local/bin (found: ${node:-none}); the sandbox hides /home" false
  [[ -n $node ]] || node=/usr/bin/node
  need "user $WOLF_USER is missing" hasuser "$WOLF_USER"
  need "$DOMAINS missing" test -d "$DOMAINS"
  need "$INBOX missing" test -d "$INBOX"
  need "$RECEIPTS missing" test -d "$RECEIPTS"
  if [[ -z $BIND ]]; then BIND="$(tailscale ip -4 2>/dev/null | head -n1 || true)"; fi
  if [[ -z $BIND ]] && ((DRY)); then echo "WOULD FAIL: no tailscale IPv4 (pass --bind)"; BIND="<tailscale-ip>"; elif [[ -z $BIND ]]; then die "no tailscale IPv4; pass --bind IP"; fi
  if [[ $BIND != "<tailscale-ip>" ]]; then
    valid_ipv4 "$BIND" || die "--bind $BIND is not an IPv4 address"
    [[ $BIND != 0.0.0.0 ]] || die "refusing wildcard bind"
  fi
  local foreign
  foreign="$(port_foreign_listener "$PORT" || true)"
  [[ -z $foreign ]] || need "port $PORT is already in use by something other than hubd: $foreign" false
  if [[ -e $ENV_FILE ]]; then
    local p h
    p="$(sed -n 's/^HUBD_PORT=//p' "$ENV_FILE" | tail -n1)"; h="$(sed -n 's/^HUBD_HOST=//p' "$ENV_FILE" | tail -n1)"
    valid_port "${p:-x}" || die "existing $ENV_FILE has a bad HUBD_PORT (1024-65535, not 3141)"
    valid_ipv4 "${h:-x}" && [[ $h != 0.0.0.0 ]] || die "existing $ENV_FILE has a bad HUBD_HOST (IPv4, not 0.0.0.0)"
  fi
  echo "file-mode survey of the real paths (find -L; the /var/wolfpack/kb paths are symlinks):"
  find -L "$DOMAINS" "$WOLF_HOME/librarian" -type f -printf '%m %u\n' 2>/dev/null | sort | uniq -c || true
  echo "target: bind $BIND:$PORT, node $node, wolves lanes: ${WOLVES[*]}"
  access_checks

  log "user and group"
  getent group "$HUBD_GROUP" >/dev/null 2>&1 || run groupadd --system "$HUBD_GROUP"
  hubd_user_exists || run useradd --system --gid "$HUBD_GROUP" --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$HUBD_USER"
  if ! ((DRY)); then access_checks; fi # now the user exists: fail before anything else is installed

  log "directories"
  run install -d -o "$HUBD_USER" -g "$HUBD_GROUP" -m 0700 "$DATA_DIR" "$DATA_DIR/kb" "$DATA_DIR/kb/base" "$DATA_DIR/kb/ops"
  run install -d -o root -g root -m 0755 "$OPT" "$OPT/releases" "$ENV_DIR"

  # hubd's kb/base stays hub-owned (it regenerates <kbBase>/domains.yaml on every registry write; it must not touch Dewey's file).
  # Only domains/ is shared: a symlink to Dewey's real domains dir (the sandbox binds the real path read-only).
  if [[ -L $DATA_DIR/kb/base ]]; then die "$DATA_DIR/kb/base is a symlink (old layout); remove it by hand first"; fi
  if [[ -L $DATA_DIR/kb/base/domains ]]; then
    if [[ "$(readlink "$DATA_DIR/kb/base/domains")" != "$DOMAINS" ]]; then
      echo "correcting domains symlink ($(readlink "$DATA_DIR/kb/base/domains") -> $DOMAINS)"
      run ln -sfn "$DOMAINS" "$DATA_DIR/kb/base/domains"
      run chown -h "$HUBD_USER:$HUBD_GROUP" "$DATA_DIR/kb/base/domains"
    fi
  else
    [[ ! -e $DATA_DIR/kb/base/domains ]] || die "$DATA_DIR/kb/base/domains exists and is not a symlink; refusing to replace"
    run ln -s "$DOMAINS" "$DATA_DIR/kb/base/domains"
    run chown -h "$HUBD_USER:$HUBD_GROUP" "$DATA_DIR/kb/base/domains"
  fi

  log "per-wolf lane dirs (hubd would otherwise create them 755 hubd-owned, and Dewey could not write into them)"
  for d in "$INBOX" "$RECEIPTS"; do
    for w in "${WOLVES[@]}"; do
      if [[ -d $d/$w ]]; then echo "exists: $d/$w ($(stat -c '%U %a' "$d/$w"))"; else
        run install -d -o "$WOLF_USER" -g "$WOLF_USER" -m 0777 "$d/$w"
      fi
    done
  done
  # Dirs hubd (storeContribution) or Dewey's intake would create inside an inbox lane: _bad/ (quarantine) and _processed/ (handled).
  # Dewey moves files INTO them (renameSync), so they must be Dewey-writable even if hubd created them first: pre-create, only when missing.
  for w in "${WOLVES[@]}"; do
    for sub in _bad _processed; do
      if [[ -d $INBOX/$w/$sub ]]; then echo "exists: $INBOX/$w/$sub ($(stat -c '%U %a' "$INBOX/$w/$sub"))"; else
        run install -d -o "$WOLF_USER" -g "$WOLF_USER" -m 0777 "$INBOX/$w/$sub"
      fi
    done
  done

  log "env file (written only if missing)"
  if [[ -e $ENV_FILE ]]; then
    echo "keeping existing $ENV_FILE"
    run chown root:root "$ENV_FILE"; run chmod 600 "$ENV_FILE"
  elif ((DRY)); then
    echo "DRY-RUN: write $ENV_FILE (root:root 600) from hubd.env.example with HUBD_HOST=$BIND HUBD_PORT=$PORT"
  else
    (
      umask 077
      sed -e "s|^HUBD_HOST=.*|HUBD_HOST=$BIND|" -e "s|^HUBD_PORT=.*|HUBD_PORT=$PORT|" "$HERE/hubd.env.example" >"$ENV_FILE.tmp"
      chown root:root "$ENV_FILE.tmp"; chmod 600 "$ENV_FILE.tmp"; mv "$ENV_FILE.tmp" "$ENV_FILE"
    )
  fi

  log "systemd unit"
  if ((DRY)); then echo "DRY-RUN: install $UNIT from hubd.service with @NODE@=$node"; else
    sed "s|@NODE@|$node|" "$HERE/hubd.service" >"$UNIT.tmp" && chmod 644 "$UNIT.tmp" && mv "$UNIT.tmp" "$UNIT"
  fi
  if ((HUB_WRITES)); then
    # Work writes (POST /v1/work ...) render domains/<d>/work/<id>.md; with domains/ read-only they fail. Make just those dirs writable.
    local rw=()
    while IFS= read -r d; do rw+=("$d"); done < <(find -L "$DOMAINS" -mindepth 2 -maxdepth 2 -type d -name work 2>/dev/null | sort)
    echo "hub-writes (UNTESTED under real systemd): work dirs writable: ${rw[*]:-none found}"
    if ((${#rw[@]} == 0)); then
      warn "no domains/*/work dirs found; NOT writing the drop-in (an empty BindPaths= would reset the unit's inbox/receipts binds)"
    elif ((DRY)); then echo "DRY-RUN: write $DROPIN_DIR/work-writes.conf (BindPaths= and ReadWritePaths= for ${#rw[@]} work dir(s); systemd does not expand globs, re-run after adding a domain or work dir)"; else
      install -d -m 0755 "$DROPIN_DIR"
      # BindPaths= is a list: the drop-in must repeat the unit's own entries, or it would replace them.
      printf '[Service]\nBindPaths=%s %s %s\nReadWritePaths=%s\n' "$INBOX" "$RECEIPTS" "${rw[*]}" "${rw[*]}" >"$DROPIN_DIR/work-writes.conf"
    fi
  else
    echo "domains/ stays read-only for hubd: work-item writes and KB commits fail by design (use --hub-writes to allow work/ dirs)"
  fi
  run systemctl daemon-reload
  run systemctl enable hubd.service
  echo "setup done. Next: install a bundle (setup.sh install --bundle <dir>), then 'systemctl start hubd'."
}

cmd_install() {
  [[ -n $BUNDLE ]] || die "install needs --bundle <dir>"
  [[ -f $BUNDLE/hubd.mjs ]] || die "$BUNDLE/hubd.mjs not found"
  local ver rel out node
  ver="$(cat "$BUNDLE/VERSION" 2>/dev/null || echo unknown)"
  rel="$OPT/releases/$(date -u +%Y%m%dT%H%M%SZ)-$ver"
  node="$(command -v node || true)"
  log "new release $rel (current stays live until the symlink flips)"
  if ((DRY)); then
    echo "DRY-RUN: install bundle files into $rel; smoke-test it (node hubd.mjs prints usage); flip $OPT/current -> $rel (old current -> $OPT/previous); restart hubd only if active; prune to $KEEP_RELEASES releases"
    return
  fi
  [[ -n $node ]] || die "node not found"
  install -d -m 0755 "$rel"
  install -m 0644 "$BUNDLE/hubd.mjs" "$BUNDLE/RUNBOOK.md" "$BUNDLE/VERSION" "$rel/"
  out="$("$node" "$rel/hubd.mjs" 2>&1 || true)" # no args prints usage and exits 1
  [[ $out == usage:* ]] || { rm -rf "$rel"; die "bundle failed its smoke test; nothing changed"; }
  if [[ -L $OPT/current ]]; then ln -sfn "$(readlink -f "$OPT/current")" "$OPT/previous.new" && mv -T "$OPT/previous.new" "$OPT/previous"; fi
  ln -sfn "$rel" "$OPT/current.new" && mv -T "$OPT/current.new" "$OPT/current" # rename(2): atomic
  if systemctl is-active --quiet hubd; then systemctl restart hubd; echo "restarted hubd"; fi
  local cur prev old
  cur="$(readlink -f "$OPT/current")"; prev="$(readlink -f "$OPT/previous" 2>/dev/null || true)"
  # shellcheck disable=SC2012
  ls -1dt "$OPT"/releases/* | tail -n +"$((KEEP_RELEASES + 1))" | while read -r old; do [[ $old == "$cur" || $old == "$prev" ]] || rm -rf "$old"; done
  echo "installed $ver"
}

cmd_rollback() {
  if ((DRY)); then echo "DRY-RUN: swap $OPT/current and $OPT/previous (needs $OPT/previous to exist), restart hubd if active"; [[ -L $OPT/previous ]] || echo "WOULD FAIL: no $OPT/previous"; return; fi
  [[ -L $OPT/previous ]] || die "no $OPT/previous to roll back to"
  local cur prev
  cur="$(readlink -f "$OPT/current")"; prev="$(readlink -f "$OPT/previous")"
  [[ -f $prev/hubd.mjs ]] || die "$prev has no hubd.mjs"
  ln -sfn "$prev" "$OPT/current.new" && mv -T "$OPT/current.new" "$OPT/current"
  ln -sfn "$cur" "$OPT/previous.new" && mv -T "$OPT/previous.new" "$OPT/previous"
  if systemctl is-active --quiet hubd; then systemctl restart hubd; fi
  echo "rolled back to $(cat "$prev/VERSION" 2>/dev/null || echo "$prev")"
}

cmd_uninstall() {
  log "uninstall hubd (Dewey's dirs are never touched; lane dirs created by setup are left in place)"
  if ((DRY)) || systemctl cat hubd.service >/dev/null 2>&1; then run systemctl disable --now hubd.service; else echo "hubd.service not installed; skipping disable"; fi
  run rm -f "$UNIT"
  run rm -rf "$DROPIN_DIR"
  run systemctl daemon-reload
  run rm -rf "$OPT"
  if ((PURGE)); then
    echo "--purge: deleting hub state. Run 'hubd export' first if you want to keep it."
    run rm -rf "$DATA_DIR"
    run rm -f "$ENV_FILE"
    run userdel "$HUBD_USER"
  else
    echo "kept: $DATA_DIR (hub state), $ENV_FILE, user $HUBD_USER (use --purge to remove)"
  fi
}

"cmd_$CMD"
