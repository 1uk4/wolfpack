#!/usr/bin/env bash
# Install the sfo-01 auto-updater (work-wolfpack-qrU6cCO). UNVERIFIED: not yet run on a host. Run as root ON the host from a copy
# of the repo (it needs deploy/auto-update, scripts/auto-update.mjs, scripts/release-components.json, infra/release/deploy-release.sh).
#   setup.sh [--dry-run] install      copy the files to /opt/wolfpack-auto-update, write the units and (if missing) the env file
#   setup.sh [--dry-run] uninstall    stop + disable the timer, remove the units and /opt/wolfpack-auto-update (status dir kept)
# It never enables the timer and never sets WOLFPACK_AUTO_UPDATE=1: turning it on is the owner's step (RUNBOOK.md).
# It also installs wolfpack-auto-update-now.service (no timer): the console's Update button starts it (work-wolfpack-7eP9W3Z). "Button only"
# = install, and leave the timer disabled.
set -euo pipefail

DRY=0 CMD=""
OPT=/opt/wolfpack-auto-update
ENV_FILE=/etc/wolfpack/auto-update.env
UNIT_DIR=/etc/systemd/system
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

die() { echo "setup.sh: $*" >&2; exit 1; }
log() { echo "==> $*"; }
run() { if ((DRY)); then printf 'DRY-RUN:'; printf ' %q' "$@"; printf '\n'; else "$@"; fi; }

while (($#)); do
  case "$1" in
    --dry-run) DRY=1 ;;
    install|uninstall) CMD=$1 ;;
    *) die "usage: setup.sh [--dry-run] install|uninstall" ;;
  esac
  shift
done
[ -n "$CMD" ] || die "usage: setup.sh [--dry-run] install|uninstall"
((DRY)) || [ "$(id -u)" = 0 ] || die "run as root"

if [ "$CMD" = uninstall ]; then
  run systemctl disable --now wolfpack-auto-update.timer || true
  run systemctl stop wolfpack-auto-update-now.service || true
  run rm -f "$UNIT_DIR/wolfpack-auto-update.timer" "$UNIT_DIR/wolfpack-auto-update.service" "$UNIT_DIR/wolfpack-auto-update-now.service" "$UNIT_DIR/wolfpack-auto-update-now@.service"
  run systemctl daemon-reload
  run rm -rf --one-file-system "$OPT"
  log "removed; $ENV_FILE and /var/lib/wolfpack-auto-update kept"
  exit 0
fi

SRC=("$ROOT/scripts/auto-update.mjs" "$ROOT/scripts/release-components.json" "$ROOT/infra/release/deploy-release.sh" "$HERE/RUNBOOK.md")
for f in "${SRC[@]}" "$HERE/wolfpack-auto-update.service" "$HERE/wolfpack-auto-update-now.service" "$HERE/wolfpack-auto-update-now@.service" "$HERE/wolfpack-auto-update.timer" "$HERE/auto-update.env.example"; do
  [ -f "$f" ] || die "missing $f (run from a full repo copy)"
done
node=$(command -v node) || die "node not found"
"$node" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=9)?0:1)' || die "node >= 22.9 needed"

log "files -> $OPT"
run install -d -m 0755 -o root -g root "$OPT"
for f in "${SRC[@]}"; do run install -m 0644 -o root -g root "$f" "$OPT/"; done
run chmod 0755 "$OPT/deploy-release.sh"

log "env file"
if [ -e "$ENV_FILE" ]; then echo "keeping existing $ENV_FILE"; run chmod 600 "$ENV_FILE"
else run install -m 0600 -o root -g root "$HERE/auto-update.env.example" "$ENV_FILE"; fi

log "systemd units (timer NOT enabled)"
if ((DRY)); then echo "DRY-RUN: write $UNIT_DIR/wolfpack-auto-update.service (@NODE@=$node), wolfpack-auto-update-now.service and .timer"; else
  sed "s|@NODE@|$node|" "$HERE/wolfpack-auto-update.service" >"$UNIT_DIR/wolfpack-auto-update.service.tmp"
  chmod 644 "$UNIT_DIR/wolfpack-auto-update.service.tmp"; mv "$UNIT_DIR/wolfpack-auto-update.service.tmp" "$UNIT_DIR/wolfpack-auto-update.service"
  install -m 0644 "$HERE/wolfpack-auto-update.timer" "$UNIT_DIR/wolfpack-auto-update.timer"
  sed "s|@NODE@|$node|" "$HERE/wolfpack-auto-update-now.service" >"$UNIT_DIR/wolfpack-auto-update-now.service.tmp"
  chmod 644 "$UNIT_DIR/wolfpack-auto-update-now.service.tmp"; mv "$UNIT_DIR/wolfpack-auto-update-now.service.tmp" "$UNIT_DIR/wolfpack-auto-update-now.service"
  sed "s|@NODE@|$node|" "$HERE/wolfpack-auto-update-now@.service" >"$UNIT_DIR/wolfpack-auto-update-now@.service.tmp"
  chmod 644 "$UNIT_DIR/wolfpack-auto-update-now@.service.tmp"; mv "$UNIT_DIR/wolfpack-auto-update-now@.service.tmp" "$UNIT_DIR/wolfpack-auto-update-now@.service"
fi
run systemctl daemon-reload

log "updater state dir stays root-only; the console-writable subscription.json gets its own directory"
run install -d -m 0755 -o root -g root /var/lib/wolfpack-auto-update
if getent group console >/dev/null 2>&1; then run install -d -m 0775 -o root -g console /var/lib/wolfpack-subscription; else run install -d -m 0775 -o root -g root /var/lib/wolfpack-subscription; echo "NOTICE: no console group yet; re-run this after deploy/console/setup.sh so the panel can save its channel and mode"; fi
log "installed (wolfpack-auto-update-now[@].service for the console's Update buttons need no further step; install deploy/console/50-console-restart.rules via deploy/console/setup.sh for polkit)"
log "To also turn the timer on: set WOLFPACK_AUTO_UPDATE=1 in $ENV_FILE, then systemctl enable --now wolfpack-auto-update.timer (RUNBOOK.md)"
