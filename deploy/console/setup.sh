#!/usr/bin/env bash
# Idempotent console setup/install for sfo-01. Run as root ON the host, after the owner confirms.
#   setup.sh [--dry-run] setup    [--port N]
#   setup.sh [--dry-run] install  --bundle <dir with app/ (server.js ...), console.service, RUNBOOK.md, VERSION>
#   setup.sh [--dry-run] rollback
#   setup.sh [--dry-run] uninstall [--purge]
# --dry-run prints every state-changing action ("DRY-RUN: ...") and changes nothing; read-only probes still run.
set -euo pipefail

DRY=0 CMD="" BUNDLE="" PORT=3200 PURGE=0
USER_=console
GROUP_=console
OPT=/opt/wolfpack-console
DATA_DIR=/var/lib/console
ENV_DIR=/etc/wolfpack
ENV_FILE=$ENV_DIR/console.env
UNIT=/etc/systemd/system/console.service
KEEP_RELEASES=5
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "setup.sh: $*" >&2; exit 1; }
log() { echo "==> $*"; }
run() { if ((DRY)); then printf 'DRY-RUN:'; printf ' %q' "$@"; printf '\n'; else "$@"; fi; }
need() { local msg=$1; shift; if "$@"; then return 0; fi; if ((DRY)); then echo "WOULD FAIL: $msg"; else die "$msg"; fi; }
valid_port() { [[ $1 =~ ^[0-9]+$ ]] && ((10#$1 >= 1024 && 10#$1 <= 65535 && 10#$1 != 3141 && 10#$1 != 3150)); }

while (($#)); do
  case "$1" in
    --dry-run) DRY=1 ;;
    --bundle) BUNDLE="${2:?--bundle needs a dir}"; shift ;;
    --port) PORT="${2:?--port needs a number}"; shift ;;
    --purge) PURGE=1 ;;
    setup | install | rollback | uninstall) CMD="$1" ;;
    *) die "unknown argument $1" ;;
  esac
  shift
done
[[ -n $CMD ]] || die "usage: setup.sh [--dry-run] setup|install|rollback|uninstall [options]"
valid_port "$PORT" || die "bad --port $PORT (1024-65535, never 3141 or 3150)"
((DRY)) || [[ $EUID -eq 0 ]] || die "run as root (or use --dry-run)"

user_exists() { id "$USER_" >/dev/null 2>&1; }
# Is the TCP port bound by something other than our own console? Prints the offending line.
port_foreign_listener() {
  local line pid main
  line="$(ss -ltnpH 2>/dev/null | awk -v p=":$1" '$4 ~ p"$" {print; exit}')" || true
  [[ -n $line ]] || return 1
  pid="$(sed -n 's/.*pid=\([0-9]*\).*/\1/p' <<<"$line" | head -n1)"
  main="$(systemctl show -p MainPID --value console 2>/dev/null || echo 0)"
  if [[ -n $pid && $pid == "$main" && $main != 0 ]]; then return 1; fi
  echo "$line"
}

cmd_setup() {
  local node foreign
  log "preflight (read-only)"
  node="$(command -v node || true)"
  [[ $node == /usr/bin/node || $node == /usr/local/bin/node ]] || need "node must be in /usr/bin or /usr/local/bin (found: ${node:-none}); the sandbox hides /home" false
  [[ -n $node ]] || node=/usr/bin/node
  if [[ -n $node && -x $node ]]; then
    local major; major="$("$node" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    ((major >= 22)) || need "node 22+ required (found major $major)" false
  fi
  foreign="$(port_foreign_listener "$PORT" || true)"
  [[ -z $foreign ]] || need "port $PORT is already in use by something other than the console: $foreign" false
  if [[ -e $ENV_FILE ]]; then
    local p h
    p="$(sed -n 's/^CONSOLE_PORT=//p' "$ENV_FILE" | tail -n1)"; h="$(sed -n 's/^CONSOLE_HOST=//p' "$ENV_FILE" | tail -n1)"
    valid_port "${p:-x}" || die "existing $ENV_FILE has a bad CONSOLE_PORT"
    [[ ${h:-x} == 127.0.0.1 ]] || die "existing $ENV_FILE has CONSOLE_HOST != 127.0.0.1"
  fi
  echo "target: 127.0.0.1:$PORT, node $node"

  log "user and group"
  getent group "$GROUP_" >/dev/null 2>&1 || run groupadd --system "$GROUP_"
  user_exists || run useradd --system --gid "$GROUP_" --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$USER_"

  log "directories"
  run install -d -o "$USER_" -g "$GROUP_" -m 0700 "$DATA_DIR"
  run install -d -o "$USER_" -g "$GROUP_" -m 0700 "$DATA_DIR/data" # LH_DATA_DIR (console.env)
  run install -d -o root -g root -m 0755 "$OPT" "$OPT/releases" "$ENV_DIR"

  log "env file (written only if missing)"
  if [[ -e $ENV_FILE ]]; then
    echo "keeping existing $ENV_FILE"
    run chown root:root "$ENV_FILE"; run chmod 600 "$ENV_FILE"
  elif ((DRY)); then
    echo "DRY-RUN: write $ENV_FILE (root:root 600) from console.env.example with CONSOLE_PORT=$PORT (edit the CHANGE-ME host names before starting)"
  else
    (
      umask 077
      sed -e "s|^CONSOLE_PORT=.*|CONSOLE_PORT=$PORT|" "$HERE/console.env.example" >"$ENV_FILE.tmp"
      chown root:root "$ENV_FILE.tmp"; chmod 600 "$ENV_FILE.tmp"; mv "$ENV_FILE.tmp" "$ENV_FILE"
    )
  fi

  log "systemd unit"
  if ((DRY)); then echo "DRY-RUN: install $UNIT from console.service with @NODE@=$node"; else
    sed "s|@NODE@|$node|" "$HERE/console.service" >"$UNIT.tmp" && chmod 644 "$UNIT.tmp" && mv "$UNIT.tmp" "$UNIT"
  fi
  run systemctl daemon-reload
  run systemctl enable console.service
  echo "setup done. Next: edit $ENV_FILE (CHANGE-ME host names), 'setup.sh install --bundle <dir>', then 'systemctl start console'."
}

cmd_install() {
  [[ -n $BUNDLE ]] || die "install needs --bundle <dir>"
  [[ -f $BUNDLE/app/server.js ]] || die "$BUNDLE/app/server.js not found"
  local ver rel out node
  ver="$(cat "$BUNDLE/VERSION" 2>/dev/null || echo unknown)"
  rel="$OPT/releases/$(date -u +%Y%m%dT%H%M%SZ)-$ver"
  node="$(command -v node || true)"
  log "new release $rel (current stays live until the symlink flips)"
  if ((DRY)); then
    echo "DRY-RUN: copy $BUNDLE/app + RUNBOOK.md + VERSION into $rel; smoke-test (node --check server.js, no stray .env/auth.json); flip $OPT/current -> $rel (old current -> $OPT/previous); restart console only if active; prune to $KEEP_RELEASES releases"
    return
  fi
  [[ -n $node ]] || die "node not found"
  install -d -m 0755 "$rel"
  cp -a "$BUNDLE/app/." "$rel/"
  install -m 0644 "$BUNDLE/VERSION" "$rel/VERSION"
  [[ -f $BUNDLE/RUNBOOK.md ]] && install -m 0644 "$BUNDLE/RUNBOOK.md" "$rel/RUNBOOK.md"
  chown -R root:root "$rel"; chmod -R go-w "$rel"
  if ! "$node" --check "$rel/server.js" 2>/dev/null || [[ -n "$(find "$rel" \( -name 'auth.json' -o -name '.env' -o -name '.env.*' \) -not -path '*/node_modules/*' -print -quit)" ]]; then
    rm -rf "$rel"; die "bundle failed its smoke test (server.js unparsable, or an env/auth file inside); nothing changed"
  fi
  if [[ -L $OPT/current ]]; then ln -sfn "$(readlink -f "$OPT/current")" "$OPT/previous.new" && mv -T "$OPT/previous.new" "$OPT/previous"; fi
  ln -sfn "$rel" "$OPT/current.new" && mv -T "$OPT/current.new" "$OPT/current" # rename(2): atomic
  install -m 0755 "$HERE/setup.sh" "$OPT/setup.sh" 2>/dev/null || true # the deploy script rolls back with the INSTALLED copy
  if systemctl is-active --quiet console; then systemctl restart console; echo "restarted console"; fi
  local cur prev old
  cur="$(readlink -f "$OPT/current")"; prev="$(readlink -f "$OPT/previous" 2>/dev/null || true)"
  # shellcheck disable=SC2012
  ls -1dt "$OPT"/releases/* | tail -n +"$((KEEP_RELEASES + 1))" | while read -r old; do [[ $old == "$cur" || $old == "$prev" ]] || rm -rf "$old"; done
  echo "installed $ver"
}

cmd_rollback() {
  if ((DRY)); then echo "DRY-RUN: swap $OPT/current and $OPT/previous (needs $OPT/previous to exist), restart console if active"; [[ -L $OPT/previous ]] || echo "WOULD FAIL: no $OPT/previous"; return; fi
  [[ -L $OPT/previous ]] || die "no $OPT/previous to roll back to"
  local cur prev
  cur="$(readlink -f "$OPT/current")"; prev="$(readlink -f "$OPT/previous")"
  [[ -f $prev/server.js ]] || die "$prev has no server.js"
  ln -sfn "$prev" "$OPT/current.new" && mv -T "$OPT/current.new" "$OPT/current"
  ln -sfn "$cur" "$OPT/previous.new" && mv -T "$OPT/previous.new" "$OPT/previous"
  if systemctl is-active --quiet console; then systemctl restart console; fi
  echo "rolled back to $(cat "$prev/VERSION" 2>/dev/null || echo "$prev")"
}

cmd_uninstall() {
  log "uninstall console"
  if ((DRY)) || systemctl cat console.service >/dev/null 2>&1; then run systemctl disable --now console.service; else echo "console.service not installed; skipping disable"; fi
  run rm -f "$UNIT"
  run systemctl daemon-reload
  run rm -rf "$OPT"
  if ((PURGE)); then
    run rm -rf "$DATA_DIR"
    run rm -f "$ENV_FILE"
    if user_exists; then run userdel "$USER_"; else echo "user $USER_ already gone"; fi
    if getent group "$GROUP_" >/dev/null 2>&1; then run groupdel "$GROUP_"; else echo "group $GROUP_ already gone"; fi
  else
    echo "kept: $DATA_DIR, $ENV_FILE, user $USER_ (use --purge to remove). Remove the tailscale serve routes separately (deploy/tailscale/serve.sh off)."
  fi
}

"cmd_$CMD"
