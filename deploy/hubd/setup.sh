#!/usr/bin/env bash
# Idempotent hubd setup/install for sfo-01. Run as root ON the host, after the owner confirms.
#   setup.sh [--dry-run] setup    [--bind IP] [--port N]
#   setup.sh [--dry-run] install  --bundle <dir with hubd.mjs, RUNBOOK.md, VERSION [, hubd.service]>
#   setup.sh [--dry-run] rollback
#   setup.sh [--dry-run] uninstall [--purge]
# --dry-run prints every state-changing action ("DRY-RUN: ...") and changes nothing; read-only probes still run.
# hubd owns everything under /var/lib/hubd (ledger, KB, curator lanes, receipts). No wolf's home dir is read, bound or changed
# (the Dewey wolf and his home were removed 2026-11-06; KB curation runs inside hubd, HUBD_CURATOR=1).
# The unit is written by `setup` and ALSO refreshed by `install` when the installed unit still binds a /home path, so a release
# deploy (which only runs `install`) migrates an old unit and drops the stale drop-ins by itself.
set -euo pipefail
# SETUP_ROOT: path prefix for the install tree and unit, so tests can drive `install` in a temp dir (also skips the root check). Unset on hosts.
R="${SETUP_ROOT:-}"

DRY=0 CMD="" BUNDLE="" BIND="" PORT=3150 PURGE=0
HUBD_USER=hubd
HUBD_GROUP=hubd
DATA_DIR=/var/lib/hubd
DOMAINS=$DATA_DIR/kb/base/domains
OPT="$R"/opt/wolfpack-hubd
ENV_DIR=/etc/wolfpack
ENV_FILE=$ENV_DIR/hubd.env
UNIT="$R"/etc/systemd/system/hubd.service
DROPIN_DIR="$R"/etc/systemd/system/hubd.service.d
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
valid_ipv4() {
  [[ $1 =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  ((10#${BASH_REMATCH[1]} <= 255 && 10#${BASH_REMATCH[2]} <= 255 && 10#${BASH_REMATCH[3]} <= 255 && 10#${BASH_REMATCH[4]} <= 255))
}
valid_port() { [[ $1 =~ ^[0-9]+$ ]] && ((10#$1 >= 1024 && 10#$1 <= 65535 && 10#$1 != 3141)); }

while (($#)); do
  case "$1" in
    --dry-run) DRY=1 ;;
    --bundle) BUNDLE="${2:?--bundle needs a dir}"; shift ;;
    --bind) BIND="${2:?--bind needs an IP}"; shift ;;
    --port) PORT="${2:?--port needs a number}"; shift ;;
    # Removed with the Dewey retirement (per-wolf lane dirs in a wolf's home, work dirs shared with a wolf user): accepted and ignored.
    --wolf | --work-user) warn "$1 is obsolete (no wolf dirs are managed any more); ignoring"; [[ -z ${2:-} ]] || shift ;;
    --hub-writes) warn "--hub-writes is obsolete (the KB and work dirs are under $DATA_DIR and writable by hubd); ignoring" ;;
    --purge) PURGE=1 ;;
    setup | install | rollback | uninstall) CMD="$1" ;;
    *) die "unknown argument $1" ;;
  esac
  shift
done
[[ -n $CMD ]] || die "usage: setup.sh [--dry-run] setup|install|rollback|uninstall [options]"
valid_port "$PORT" || die "bad --port $PORT (1024-65535, and never 3141: wolfpack-agent)"
((DRY)) || [[ -n $R || $EUID -eq 0 ]] || die "run as root (or use --dry-run)"

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

# Node path for the unit's ExecStart: the sandbox hides /home, so it must be /usr/bin/node or /usr/local/bin/node. Prefer the node on PATH;
# else reuse the ExecStart path of the installed unit when it qualifies. Prints the path; returns 1 if neither works.
resolve_node() {
  local n u
  n="$(command -v node || true)"
  if [[ $n == /usr/bin/node || $n == /usr/local/bin/node ]]; then echo "$n"; return 0; fi
  if [[ -f $UNIT ]]; then
    u="$(sed -n 's|^ExecStart=\(/[^ ]*\) .*|\1|p' "$UNIT" | head -n1)"
    if [[ $u == /usr/bin/node || $u == /usr/local/bin/node ]] && [[ -x "$R$u" ]]; then echo "$u"; return 0; fi
  fi
  return 1
}

# Install the unit from <template> (substituting @NODE@), then remove the drop-ins that only existed to patch Dewey's paths.
# Every step of the unit write is fatal, and the drop-ins are deleted only after the new unit is confirmed in place (no /home path in it).
# Idempotent. Does NOT daemon-reload or restart (callers do).
write_unit() { # write_unit <template> <node>
  local tpl=$1 node=$2 f body
  if ((DRY)); then echo "DRY-RUN: install $UNIT from $tpl with @NODE@=$node"; else
    sed "s|@NODE@|$node|" "$tpl" >"$UNIT.tmp" || die "could not render $tpl to $UNIT.tmp"
    chmod 644 "$UNIT.tmp" || die "chmod $UNIT.tmp failed"
    mv -T "$UNIT.tmp" "$UNIT" || die "could not move $UNIT.tmp into place; the old unit and its drop-ins are untouched"
    if grep -Ev '^[[:space:]]*#' "$UNIT" | grep -q '/home'; then die "$UNIT still has a /home path after the write; drop-ins NOT removed"; fi
    grep -q '^ExecStart=' "$UNIT" || die "$UNIT has no ExecStart= after the write; drop-ins NOT removed"
  fi
  [[ -d $DROPIN_DIR ]] || return 0
  # work-writes.conf (--hub-writes, bound domains/*/work under Dewey's home) and its disabled/renamed copies: obsolete, nothing to keep.
  for f in "$DROPIN_DIR"/work-writes.conf "$DROPIN_DIR"/work-writes.conf.disabled-* "$DROPIN_DIR"/work-writes.conf.off-*; do
    [[ -e $f ]] || continue
    warn "removing obsolete drop-in $f"
    run rm -f "$f"
  done
  # curator-local.conf (hand-made at the curator cutover: reset the binds, ReadWritePaths=/var/lib/hubd) is redundant now. Remove it only
  # if it holds nothing but those path settings; anything else in it is somebody's change, so leave it and say so.
  f=$DROPIN_DIR/curator-local.conf
  if [[ -e $f ]]; then
    body="$(grep -Ev '^[[:space:]]*(#.*)?$|^\[Service\]$|^(BindReadOnlyPaths|BindPaths|ReadWritePaths)=(/var/lib/hubd)?$' "$f" || true)"
    if [[ -z $body ]]; then warn "removing redundant drop-in $f (the unit itself now has ReadWritePaths=$DATA_DIR and no /home binds)"; run rm -f "$f"
    else warn "$f has settings beyond the path resets; NOT removing it. Review it by hand:"$'\n'"$body"; fi
  fi
  if ((!DRY)); then rmdir "$DROPIN_DIR" 2>/dev/null || true; fi
}

cmd_setup() {
  local node
  log "preflight (read-only)"
  node="$(command -v node || true)"
  [[ $node == /usr/bin/node || $node == /usr/local/bin/node ]] || need "node must be in /usr/bin or /usr/local/bin (found: ${node:-none}); the sandbox hides /home" false
  [[ -n $node ]] || node=/usr/bin/node
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
    if grep -Eq '^[[:space:]]*HUBD_(INBOX|RECEIPTS)_ROOT=' "$ENV_FILE"; then
      warn "$ENV_FILE still sets HUBD_INBOX_ROOT / HUBD_RECEIPTS_ROOT: remove them (they point into a retired wolf home; the curator refuses to start with them)"
    fi
  fi
  echo "target: bind $BIND:$PORT, node $node"

  log "user and group"
  getent group "$HUBD_GROUP" >/dev/null 2>&1 || run groupadd --system "$HUBD_GROUP"
  hubd_user_exists || run useradd --system --gid "$HUBD_GROUP" --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$HUBD_USER"

  log "directories"
  run install -d -o "$HUBD_USER" -g "$HUBD_GROUP" -m 0700 "$DATA_DIR" "$DATA_DIR/kb" "$DATA_DIR/kb/base" "$DATA_DIR/kb/ops"
  run install -d -o root -g root -m 0755 "$OPT" "$OPT/releases" "$ENV_DIR"
  # The KB is hub-owned: a real directory under the data dir. A symlink here is the old layout (into a wolf's home): migrate by hand.
  if [[ -L $DATA_DIR/kb/base || -L $DOMAINS ]]; then die "$DATA_DIR/kb/base or its domains/ is a symlink (old layout into a wolf's home); migrate it to a real hubd-owned directory first (RUNBOOK.md section 8, step 2)"; fi
  run install -d -o "$HUBD_USER" -g "$HUBD_GROUP" -m 0755 "$DOMAINS"

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

  log "systemd unit (and removal of obsolete drop-ins)"
  write_unit "$HERE/hubd.service" "$node"
  run systemctl daemon-reload
  run systemctl enable hubd.service
  echo "setup done. Next: install a bundle (setup.sh install --bundle <dir>), then 'systemctl start hubd'."
}

# `install` (every release deploy) rewrites the unit from the bundle whenever the rendered unit differs from the installed one
# (work-wolfpack-jScCkFy), so a unit change reaches hosts that already have one. An identical unit is left alone (no backup, no reload).
migrate_old_unit() {
  local tpl node ts bak
  [[ -f $UNIT ]] || return 0
  tpl="$BUNDLE/hubd.service"; [[ -f $tpl ]] || tpl="$HERE/hubd.service"
  [[ -f $tpl ]] || { warn "installed $UNIT exists but no hubd.service template was found next to the bundle or setup.sh; run 'setup.sh setup' by hand"; return 0; }
  node="$(resolve_node)" || die "cannot fill @NODE@: node on PATH is not /usr/bin/node or /usr/local/bin/node and the installed unit's ExecStart does not name one; nothing changed (run 'setup.sh setup' by hand)"
  if sed "s|@NODE@|$node|" "$tpl" | cmp -s - "$UNIT"; then return 0; fi
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  bak="$OPT/unit-backup-$ts"
  log "installed unit differs from the bundle: backing up to $UNIT.bak-$ts and $bak, then replacing it from $tpl"
  # The unit copy sits beside the unit (not a *.service, systemd ignores it); the drop-ins go outside /etc/systemd so they are never loaded.
  run cp -a "$UNIT" "$UNIT.bak-$ts"
  run install -d -m 0700 "$bak"
  run cp -a "$UNIT" "$bak/hubd.service"
  if [[ -d $DROPIN_DIR ]]; then run cp -a "$DROPIN_DIR" "$bak/hubd.service.d"; fi
  echo "backup: $UNIT.bak-$ts and $bak (restore: copy back, systemctl daemon-reload, restart hubd)"
  write_unit "$tpl" "$node"
  run systemctl daemon-reload
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
    migrate_old_unit
    echo "DRY-RUN: install bundle files into $rel; smoke-test it (node hubd.mjs prints usage); flip $OPT/current -> $rel (old current -> $OPT/previous); restart hubd only if active; prune to $KEEP_RELEASES releases"
    return
  fi
  [[ -n $node ]] || die "node not found"
  install -d -m 0755 "$rel"
  install -m 0644 "$BUNDLE/hubd.mjs" "$BUNDLE/RUNBOOK.md" "$BUNDLE/VERSION" "$rel/"
  out="$("$node" "$rel/hubd.mjs" 2>&1 || true)" # no args prints usage and exits 1
  [[ $out == usage:* ]] || { rm -rf "$rel"; die "bundle failed its smoke test; nothing changed"; }
  migrate_old_unit # after the smoke test, before the flip; the restart below applies it
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
  log "uninstall hubd (no wolf dirs are touched)"
  if ((DRY)) || systemctl cat hubd.service >/dev/null 2>&1; then run systemctl disable --now hubd.service; else echo "hubd.service not installed; skipping disable"; fi
  run rm -f "$UNIT"
  run rm -rf "$DROPIN_DIR"
  run systemctl daemon-reload
  run rm -rf "$OPT"
  if ((PURGE)); then
    echo "--purge: deleting hub state. Run 'hubd export' first if you want to keep it."
    run rm -rf "$DATA_DIR"
    run rm -f "$ENV_FILE"
    if hubd_user_exists; then run userdel "$HUBD_USER"; else echo "user $HUBD_USER already gone"; fi
    if getent group "$HUBD_GROUP" >/dev/null 2>&1; then run groupdel "$HUBD_GROUP"; else echo "group $HUBD_GROUP already gone"; fi
  else
    echo "kept: $DATA_DIR (hub state), $ENV_FILE, user $HUBD_USER (use --purge to remove)"
  fi
}

"cmd_$CMD"
