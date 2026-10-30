#!/usr/bin/env bash
# Idempotent hubd setup/install for sfo-01. Run as root ON the host, after the owner confirms.
#   setup.sh [--dry-run] setup   [--bind IP] [--port N] [--kb-write]
#   setup.sh [--dry-run] install --bundle <dir with hubd.mjs, RUNBOOK.md, VERSION>
#   setup.sh [--dry-run] rollback
# --dry-run prints every action and changes nothing (read-only probes still run).
set -euo pipefail

DRY=0
CMD=""
BUNDLE=""
BIND=""
PORT=3150
KB_WRITE=0
HUBD_USER=hubd
HUBD_GROUP=hubd
WOLF_USER=wolf-W1hOrJ
WOLF_HOME=/home/wolf-W1hOrJ
DATA_DIR=/var/lib/hubd
OPT=/opt/wolfpack-hubd
ENV_DIR=/etc/wolfpack
ENV_FILE=$ENV_DIR/hubd.env
UNIT=/etc/systemd/system/hubd.service
KEEP_RELEASES=5
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "setup.sh: $*" >&2; exit 1; }
log() { echo "==> $*"; }
run() { if ((DRY)); then printf 'DRY-RUN:'; printf ' %q' "$@"; printf '\n'; else "$@"; fi; }

while (($#)); do
  case "$1" in
    --dry-run) DRY=1 ;;
    --bundle) BUNDLE="${2:?--bundle needs a dir}"; shift ;;
    --bind) BIND="${2:?--bind needs an IP}"; shift ;;
    --port) PORT="${2:?--port needs a number}"; shift ;;
    --kb-write) KB_WRITE=1 ;;
    setup | install | rollback) CMD="$1" ;;
    *) die "unknown argument $1" ;;
  esac
  shift
done
[[ -n $CMD ]] || die "usage: setup.sh [--dry-run] setup|install|rollback [options]"
[[ $PORT =~ ^[0-9]+$ ]] || die "bad port"
[[ $PORT != 3141 ]] || die "port 3141 is wolfpack-agent"
((DRY)) || [[ $EUID -eq 0 ]] || die "run as root (or use --dry-run)"

cmd_setup() {
  log "preflight"
  command -v setfacl >/dev/null || { ((DRY)) && echo "WOULD FAIL: setfacl missing (apt-get install -y acl)" || die "setfacl missing: apt-get install -y acl"; }
  NODE="$(command -v node || true)"
  [[ -n $NODE ]] || { ((DRY)) && { echo "WOULD FAIL: node not found"; NODE=/usr/bin/node; } || die "node not found"; }
  id "$WOLF_USER" >/dev/null 2>&1 || { ((DRY)) && echo "WOULD FAIL: user $WOLF_USER missing" || die "user $WOLF_USER missing"; }
  [[ -d $WOLF_HOME/knowledge/base/domains ]] || echo "WARNING: $WOLF_HOME/knowledge/base/domains not found"
  if [[ -z $BIND ]]; then BIND="$(tailscale ip -4 2>/dev/null | head -n1 || true)"; fi
  [[ -n $BIND ]] || { ((DRY)) && { echo "WOULD FAIL: no tailscale IPv4 (pass --bind)"; BIND="<tailscale-ip>"; } || die "no tailscale IPv4; pass --bind IP"; }
  [[ $BIND != 0.0.0.0 && $BIND != :: ]] || die "refusing wildcard bind"
  if ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$PORT\$"; then echo "WARNING: port $PORT already listening (ok only if it is hubd itself)"; fi

  log "user and group"
  getent group "$HUBD_GROUP" >/dev/null || run groupadd --system "$HUBD_GROUP"
  id "$HUBD_USER" >/dev/null 2>&1 || run useradd --system --gid "$HUBD_GROUP" --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$HUBD_USER"

  log "directories"
  run install -d -o "$HUBD_USER" -g "$HUBD_GROUP" -m 0700 "$DATA_DIR" "$DATA_DIR/kb" "$DATA_DIR/kb/ops"
  run install -d -o root -g root -m 0755 "$OPT" "$OPT/releases"
  run install -d -o root -g root -m 0755 "$ENV_DIR"

  # hubd's KB root is <data>/kb/base. It must stay hub-owned because hubd regenerates <kbBase>/domains.yaml on every registry write
  # (it must NOT overwrite Dewey's file). Only domains/ is shared with Dewey's curated KB: a symlink, read-only via ACL unless --kb-write.
  if [[ -L $DATA_DIR/kb/base ]]; then die "$DATA_DIR/kb/base is a symlink (old layout); remove it by hand first"; fi
  run install -d -o "$HUBD_USER" -g "$HUBD_GROUP" -m 0700 "$DATA_DIR/kb/base"
  if [[ ! -L $DATA_DIR/kb/base/domains ]]; then
    [[ ! -e $DATA_DIR/kb/base/domains ]] || die "$DATA_DIR/kb/base/domains exists and is not a symlink; refusing to replace"
    run ln -s "$WOLF_HOME/knowledge/base/domains" "$DATA_DIR/kb/base/domains"
    run chown -h "$HUBD_USER:$HUBD_GROUP" "$DATA_DIR/kb/base/domains"
  fi

  log "ACLs on $WOLF_USER paths (hubd gets only what it needs; Dewey keeps access to files hubd creates)"
  # Traverse only (x, no listing) on the path down to the allowed dirs.
  for d in "$WOLF_HOME" "$WOLF_HOME/knowledge" "$WOLF_HOME/knowledge/base" "$WOLF_HOME/librarian"; do
    [[ -d $d ]] || ((DRY)) || die "$d missing"
    run setfacl -m "u:$HUBD_USER:--x" "$d"
  done
  # KB: read (+ default ACL so Dewey's new files stay readable).
  if [[ -d $WOLF_HOME/knowledge/base/domains ]] || ((DRY)); then
    if ((KB_WRITE)); then perm="rwX"; else perm="rX"; fi
    run setfacl -R -m "u:$HUBD_USER:$perm" -m "d:u:$HUBD_USER:$perm" "$WOLF_HOME/knowledge/base/domains"
  fi
  # Inbox + receipts: hubd writes, Dewey (owner) keeps rwx on whatever hubd creates (default ACL + mask).
  for lane in inbox receipts; do
    d="$WOLF_HOME/librarian/$lane"
    [[ -d $d ]] || ((DRY)) || { echo "WARNING: $d missing; skipping (create it as $WOLF_USER, then re-run)"; continue; }
    run setfacl -R -m "u:$HUBD_USER:rwX" -m "d:u:$HUBD_USER:rwX" -m "d:u:$WOLF_USER:rwX" -m "d:m::rwx" "$d"
  done

  log "env file (written only if missing)"
  if [[ -e $ENV_FILE ]]; then
    echo "keeping existing $ENV_FILE"
    run chown root:root "$ENV_FILE"; run chmod 600 "$ENV_FILE"
  elif ((DRY)); then
    echo "DRY-RUN: write $ENV_FILE (root:root 600) from hubd.env.example with HUBD_HOST=$BIND HUBD_PORT=$PORT"
  else
    umask 077
    sed -e "s|^HUBD_HOST=.*|HUBD_HOST=$BIND|" -e "s|^HUBD_PORT=.*|HUBD_PORT=$PORT|" "$HERE/hubd.env.example" >"$ENV_FILE"
    chown root:root "$ENV_FILE"; chmod 600 "$ENV_FILE"
  fi

  log "systemd unit"
  if ((DRY)); then echo "DRY-RUN: install $UNIT from hubd.service with @NODE@=$NODE"; else
    sed "s|@NODE@|$NODE|" "$HERE/hubd.service" >"$UNIT.tmp" && chmod 644 "$UNIT.tmp" && mv "$UNIT.tmp" "$UNIT"
  fi
  run systemctl daemon-reload
  run systemctl enable hubd.service
  echo "setup done. Next: install a bundle (setup.sh install --bundle <dir>), then 'systemctl start hubd'."
}

cmd_install() {
  [[ -n $BUNDLE ]] || die "install needs --bundle <dir>"
  [[ -f $BUNDLE/hubd.mjs ]] || die "$BUNDLE/hubd.mjs not found"
  local ver rel out
  ver="$(cat "$BUNDLE/VERSION" 2>/dev/null || echo unknown)"
  rel="$OPT/releases/$(date -u +%Y%m%dT%H%M%SZ)-$ver"
  log "new release $rel (current stays live until the symlink flips)"
  if ((DRY)); then
    echo "DRY-RUN: install bundle files into $rel, verify 'node hubd.mjs' parses, flip $OPT/current -> $rel (previous -> $OPT/previous), restart hubd if active, prune to $KEEP_RELEASES"
    return
  fi
  install -d -m 0755 "$rel"
  install -m 0644 "$BUNDLE/hubd.mjs" "$BUNDLE/RUNBOOK.md" "$BUNDLE/VERSION" "$rel/"
  out="$("$(command -v node)" "$rel/hubd.mjs" 2>&1 || true)" # no args prints usage and exits 1
  [[ $out == usage:* ]] || { rm -rf "$rel"; die "bundle failed its smoke test; nothing changed"; }
  if [[ -L $OPT/current ]]; then ln -sfn "$(readlink -f "$OPT/current")" "$OPT/previous"; fi
  ln -sfn "$rel" "$OPT/current.new" && mv -T "$OPT/current.new" "$OPT/current"
  if systemctl is-active --quiet hubd; then systemctl restart hubd; echo "restarted hubd"; fi
  # shellcheck disable=SC2012
  ls -1dt "$OPT"/releases/* | tail -n +"$((KEEP_RELEASES + 1))" | while read -r old; do [[ $old == "$(readlink -f "$OPT/current")" || $old == "$(readlink -f "$OPT/previous" 2>/dev/null)" ]] || rm -rf "$old"; done
  echo "installed $ver"
}

cmd_rollback() {
  [[ -L $OPT/previous || ${DRY} -eq 1 ]] || die "no $OPT/previous to roll back to"
  log "rollback: current -> previous"
  if ((DRY)); then echo "DRY-RUN: swap $OPT/current and $OPT/previous, restart hubd if active"; return; fi
  local cur prev
  cur="$(readlink -f "$OPT/current")"; prev="$(readlink -f "$OPT/previous")"
  ln -sfn "$prev" "$OPT/current.new" && mv -T "$OPT/current.new" "$OPT/current"
  ln -sfn "$cur" "$OPT/previous"
  if systemctl is-active --quiet hubd; then systemctl restart hubd; fi
  echo "rolled back to $(cat "$prev/VERSION" 2>/dev/null || echo "$prev")"
}

"cmd_$CMD"
