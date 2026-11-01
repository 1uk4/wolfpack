#!/usr/bin/env bash
# Idempotent workerd (link-only) setup/install for sfo-01. Run as root ON the host, after the owner confirms.
#   setup.sh [--dry-run] setup    [--announce NAME]... [--port N]
#   setup.sh [--dry-run] install  --bundle <dir with workerd.mjs, RUNBOOK.md, VERSION>
#   setup.sh [--dry-run] rollback
#   setup.sh [--dry-run] uninstall [--purge]
# --dry-run prints every state-changing action ("DRY-RUN: ...") and changes nothing; read-only probes still run.
# Never touches Hal's unit or .env, Dewey's tree, or any KB copy. The unit starts only once /var/lib/workerd/hub.json exists (workerd pair).
set -euo pipefail

DRY=0 CMD="" BUNDLE="" PORT=7142 PURGE=0
ANNOUNCE=()
WU=workerd
WG=workerd
HAL_UNIT=wolf-ETAy7b
DATA_DIR=/var/lib/workerd
# The hub KB mirror lives OUTSIDE the 0700 state dir so Hal can read it through a group (see RUNBOOK "Hal reads the hub mirror").
KB_DIR=/var/lib/workerd-kb
KB_GROUP=wolfpack-kb
HAL_USER=wolf-ETAy7b
OPT=/opt/wolfpack-workerd
ENV_DIR=/etc/wolfpack
ENV_FILE=$ENV_DIR/workerd.env
UNIT=/etc/systemd/system/workerd.service
KEEP_RELEASES=5
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "setup.sh: $*" >&2; exit 1; }
log() { echo "==> $*"; }
run() { if ((DRY)); then printf 'DRY-RUN:'; printf ' %q' "$@"; printf '\n'; else "$@"; fi; }
# A check that must pass. In a dry run a failure is reported as "WOULD FAIL" and the run continues.
need() { # need <message> <command...>
  local msg=$1; shift
  if "$@"; then return 0; fi
  if ((DRY)); then echo "WOULD FAIL: $msg"; else die "$msg"; fi
}
valid_port() { [[ $1 =~ ^[0-9]+$ ]] && ((10#$1 >= 1024 && 10#$1 <= 65535 && 10#$1 != 3141 && 10#$1 != 3150 && 10#$1 != 7141)); }
valid_wolf() { [[ $1 =~ ^[a-z0-9][a-z0-9-]*$ ]]; }

while (($#)); do
  case "$1" in
    --dry-run) DRY=1 ;;
    --bundle) BUNDLE="${2:?--bundle needs a dir}"; shift ;;
    --port) PORT="${2:?--port needs a number}"; shift ;;
    --announce) valid_wolf "${2:?--announce needs a name}" || die "bad wolf name $2"; ANNOUNCE+=("$2"); shift ;;
    --purge) PURGE=1 ;;
    setup | install | rollback | uninstall) CMD="$1" ;;
    *) die "unknown argument $1" ;;
  esac
  shift
done
[[ -n $CMD ]] || die "usage: setup.sh [--dry-run] setup|install|rollback|uninstall [options]"
valid_port "$PORT" || die "bad --port $PORT (1024-65535, never 3141 wolfpack-agent, 3150 hubd, 7141 Mac workerd)"
((${#ANNOUNCE[@]})) || ANNOUNCE=(hal)
((DRY)) || [[ $EUID -eq 0 ]] || die "run as root (or use --dry-run)"

hal_unit_exists() { systemctl cat "$HAL_UNIT.service" >/dev/null 2>&1; }
workerd_user_exists() { id "$WU" >/dev/null 2>&1; }
# Value of KEY in a file (last assignment), empty if absent.
envval() { sed -n "s/^$2=//p" "$1" 2>/dev/null | tail -n1; }

# Is the TCP port bound by something other than our own workerd? Prints the offending line.
port_foreign_listener() {
  local line pid main
  line="$(ss -ltnpH 2>/dev/null | awk -v p=":$1" '$4 ~ p"$" {print; exit}')" || true
  [[ -n $line ]] || return 1
  pid="$(sed -n 's/.*pid=\([0-9]*\).*/\1/p' <<<"$line" | head -n1)"
  main="$(systemctl show -p MainPID --value workerd 2>/dev/null || echo 0)"
  if [[ -n $pid && $pid == "$main" && $main != 0 ]]; then return 1; fi
  echo "$line"
}

# The unit/env must never be able to spawn wolves: link-only on, something to announce, feed off. Checks the env that WILL be in force.
no_spawn_checks() { # no_spawn_checks <env file or example>
  local f=$1
  need "$f: WORKERD_LINK_ONLY must be 1 (otherwise workerd would supervise and spawn wolves)" test "$(envval "$f" WORKERD_LINK_ONLY)" = 1
  need "$f: WORKERD_ANNOUNCE is empty" test -n "$(envval "$f" WORKERD_ANNOUNCE)"
  need "$f: WORKERD_FEED must be 0 (Hal writes into Dewey's inbox directly)" test "$(envval "$f" WORKERD_FEED)" = 0
  need "$f: WORKERD_KB_LAYOUT must be base" test "$(envval "$f" WORKERD_KB_LAYOUT)" = base
  if [[ $(envval "$f" WORKERD_KB_MIRROR_GROUP_READ) == 1 ]]; then
    need "$f: WORKERD_KB_MIRROR_GROUP_READ=1 needs WORKERD_KB_MIRROR_DIR=$KB_DIR" test "$(envval "$f" WORKERD_KB_MIRROR_DIR)" = "$KB_DIR"
  fi
  need "$f: WORKERD_HOST must be 127.0.0.1" test "$(envval "$f" WORKERD_HOST)" = 127.0.0.1
  need "$f: bad WORKERD_PORT" valid_port "$(envval "$f" WORKERD_PORT)"
  need "$HERE/workerd.service ExecStart must pass --link-only" grep -Eq '^ExecStart=.* --link-only( |$)' "$HERE/workerd.service"
  need "$HERE/workerd.service must not run any wolfd" bash -c "! grep -Eqi 'wolfd|--wolves' '$HERE/workerd.service'"
}

cmd_setup() {
  local node foreign
  log "preflight (read-only)"
  node="$(command -v node || true)"
  [[ $node == /usr/bin/node || $node == /usr/local/bin/node ]] || need "node must be in /usr/bin or /usr/local/bin (found: ${node:-none}); the sandbox hides /home" false
  [[ -n $node ]] || node=/usr/bin/node
  local major
  major="$("$node" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  need "node >= 22 required (found major $major)" test "${major:-0}" -ge 22
  need "$HERE/workerd.service missing" test -f "$HERE/workerd.service"
  need "$HERE/workerd.env.example missing" test -f "$HERE/workerd.env.example"
  # Ports: hubd 3150 and the agent 3141 must be left alone; ours must be free (or already ours).
  need "ss is required for the port check but is missing" command -v ss >/dev/null
  if [[ -e $ENV_FILE ]]; then
    local envport envann
    envport="$(envval "$ENV_FILE" WORKERD_PORT)"; envann="$(envval "$ENV_FILE" WORKERD_ANNOUNCE)"
    if [[ -n $envport && $envport != "$PORT" ]]; then echo "NOTICE: $ENV_FILE exists; its WORKERD_PORT=$envport is used, --port $PORT is ignored"; fi
    if [[ -n $envann && $envann != "$(IFS=,; echo "${ANNOUNCE[*]}")" ]]; then echo "NOTICE: $ENV_FILE exists; its WORKERD_ANNOUNCE=$envann is used, --announce is ignored"; fi
    [[ -z $envport ]] || PORT="$envport"
  fi
  need "bad port $PORT" valid_port "$PORT"
  foreign="$(port_foreign_listener "$PORT" || true)"
  [[ -z $foreign ]] || need "port $PORT is already in use by something other than workerd: $foreign" false
  if [[ -e $ENV_FILE ]]; then no_spawn_checks "$ENV_FILE"; else no_spawn_checks "$HERE/workerd.env.example"; fi
  if ! ((${#ANNOUNCE[@]} == 1)) || [[ ${ANNOUNCE[0]} != hal ]]; then echo "NOTE: announcing ${ANNOUNCE[*]}"; fi
  # Hal must exist as its own unit and must not be touched; show its state for the record.
  need "$HAL_UNIT.service not found (Hal runs from his own unit; workerd must not replace it)" hal_unit_exists
  echo "Hal unit $HAL_UNIT: $(systemctl is-active "$HAL_UNIT" 2>/dev/null || echo unknown) (left untouched)"
  echo "target: node $node, 127.0.0.1:$PORT, announce ${ANNOUNCE[*]}, link-only, feed off, mirror $KB_DIR (base layout, group $KB_GROUP, via WORKERD_KB_MIRROR_DIR in the env file; default $DATA_DIR/kb-mirror)"

  log "user and group"
  getent group "$WG" >/dev/null 2>&1 || run groupadd --system "$WG"
  workerd_user_exists || run useradd --system --gid "$WG" --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$WU"

  # Shared-read group for the mirror: workerd writes, Hal (if his user exists) reads. Hal's own unit is not touched (his group list only
  # takes effect when wolf-ETAy7b.service is restarted).
  getent group "$KB_GROUP" >/dev/null 2>&1 || run groupadd --system "$KB_GROUP"
  run usermod -aG "$KB_GROUP" "$WU"
  if id "$HAL_USER" >/dev/null 2>&1; then run usermod -aG "$KB_GROUP" "$HAL_USER"; else echo "NOTE: user $HAL_USER not found; add it to $KB_GROUP by hand"; fi

  log "directories"
  run install -d -o "$WU" -g "$WG" -m 0700 "$DATA_DIR" "$DATA_DIR/ops"
  # Plain 0750, NO setgid: the unit has RestrictSUIDSGID=yes, so workerd cannot set S_ISGID. It instead chowns what it writes to this dir's group
  # (WORKERD_KB_MIRROR_GROUP_READ=1). workerd's own state above stays 0700.
  run install -d -o "$WU" -g "$KB_GROUP" -m 0750 "$KB_DIR"
  run install -d -o root -g root -m 0755 "$OPT" "$OPT/releases"
  # /etc/wolfpack is shared with hubd: create only if missing, never reset its owner or mode.
  [[ -d $ENV_DIR ]] || run install -d -o root -g root -m 0755 "$ENV_DIR"

  log "env file (written only if missing)"
  if [[ -e $ENV_FILE ]]; then
    echo "keeping existing $ENV_FILE"
    run chown root:root "$ENV_FILE"; run chmod 600 "$ENV_FILE"
  elif ((DRY)); then
    echo "DRY-RUN: write $ENV_FILE (root:root 600) from workerd.env.example with WORKERD_PORT=$PORT WORKERD_ANNOUNCE=$(IFS=,; echo "${ANNOUNCE[*]}")"
  else
    (
      umask 077
      trap 'rm -f "$ENV_FILE.tmp"' EXIT
      sed -e "s|^WORKERD_PORT=.*|WORKERD_PORT=$PORT|" -e "s|^WORKERD_ANNOUNCE=.*|WORKERD_ANNOUNCE=$(IFS=,; echo "${ANNOUNCE[*]}")|" "$HERE/workerd.env.example" >"$ENV_FILE.tmp"
      chown root:root "$ENV_FILE.tmp"; chmod 600 "$ENV_FILE.tmp"; mv "$ENV_FILE.tmp" "$ENV_FILE"
    )
  fi

  log "systemd unit (enabled, NOT started: pair first, see RUNBOOK)"
  if ((DRY)); then echo "DRY-RUN: install $UNIT from workerd.service with @NODE@=$node"; else
    sed "s|@NODE@|$node|" "$HERE/workerd.service" >"$UNIT.tmp" && chmod 644 "$UNIT.tmp" && mv "$UNIT.tmp" "$UNIT"
  fi
  run systemctl daemon-reload
  run systemctl enable workerd.service
  if systemctl is-active --quiet workerd 2>/dev/null; then echo "NOTE: workerd is running: restart it (systemctl restart workerd) to pick up a changed env file or unit."; fi
  echo "setup done. Next: install a bundle, register/pair (RUNBOOK), then 'systemctl start workerd'."
}

cmd_install() {
  [[ -n $BUNDLE ]] || die "install needs --bundle <dir>"
  [[ -f $BUNDLE/workerd.mjs ]] || die "$BUNDLE/workerd.mjs not found"
  local ver rel out node
  ver="$(cat "$BUNDLE/VERSION" 2>/dev/null || echo unknown)"
  rel="$OPT/releases/$(date -u +%Y%m%dT%H%M%SZ)-$ver"
  node="$(command -v node || true)"
  log "new release $rel (current stays live until the symlink flips)"
  if ((DRY)); then
    echo "DRY-RUN: install bundle files into $rel; smoke-test it (node workerd.mjs --help prints usage); flip $OPT/current -> $rel (old current -> $OPT/previous); restart workerd only if active; prune to $KEEP_RELEASES releases"
    return
  fi
  [[ -n $node ]] || die "node not found"
  install -d -m 0755 "$rel"
  install -m 0644 "$BUNDLE/workerd.mjs" "$BUNDLE/RUNBOOK.md" "$BUNDLE/VERSION" "$rel/"
  out="$("$node" "$rel/workerd.mjs" --help 2>&1 || true)"
  [[ $out == usage:* ]] || { rm -rf "$rel"; die "bundle failed its smoke test; nothing changed"; }
  if [[ -L $OPT/current ]]; then ln -sfn "$(readlink -f "$OPT/current")" "$OPT/previous.new" && mv -T "$OPT/previous.new" "$OPT/previous"; fi
  ln -sfn "$rel" "$OPT/current.new" && mv -T "$OPT/current.new" "$OPT/current" # rename(2): atomic
  if systemctl is-active --quiet workerd; then systemctl restart workerd; echo "restarted workerd"; fi
  local cur prev old
  cur="$(readlink -f "$OPT/current")"; prev="$(readlink -f "$OPT/previous" 2>/dev/null || true)"
  # shellcheck disable=SC2012
  ls -1dt "$OPT"/releases/* | tail -n +"$((KEEP_RELEASES + 1))" | while read -r old; do [[ $old == "$cur" || $old == "$prev" ]] || rm -rf "$old"; done
  echo "installed $ver"
}

cmd_rollback() {
  if ((DRY)); then echo "DRY-RUN: swap $OPT/current and $OPT/previous (needs $OPT/previous to exist), restart workerd if active"; [[ -L $OPT/previous ]] || echo "WOULD FAIL: no $OPT/previous"; [[ -f $OPT/current/workerd.mjs ]] || echo "WOULD FAIL: $OPT/current does not resolve"; return; fi
  [[ -L $OPT/previous ]] || die "no $OPT/previous to roll back to"
  [[ -L $OPT/current && -f $OPT/current/workerd.mjs ]] || die "$OPT/current does not resolve to a release; refusing to flip"
  local cur prev
  cur="$(readlink -f "$OPT/current")"; prev="$(readlink -f "$OPT/previous")"
  [[ -f $prev/workerd.mjs ]] || die "$prev has no workerd.mjs"
  ln -sfn "$prev" "$OPT/current.new" && mv -T "$OPT/current.new" "$OPT/current"
  ln -sfn "$cur" "$OPT/previous.new" && mv -T "$OPT/previous.new" "$OPT/previous"
  if systemctl is-active --quiet workerd; then systemctl restart workerd; fi
  echo "rolled back to $(cat "$prev/VERSION" 2>/dev/null || echo "$prev")"
}

cmd_uninstall() {
  if ((PURGE)); then
    # Best-effort: look for anything that still points at the mirror (systemd units, /etc/wolfpack, /var/wolfpack, home .env files,
    # and Hal's real EnvironmentFile= / WorkingDirectory= resolved from `systemctl cat`).
    local refs="" targets=() l v t
    while IFS= read -r l; do
      case "$l" in
        EnvironmentFile=* | WorkingDirectory=*)
          v="${l#*=}"; v="${v#-}"; v="${v%% *}"; [[ -n $v ]] && targets+=("$v") ;;
      esac
    done < <(systemctl cat "$HAL_UNIT" 2>/dev/null || true)
    for t in /etc/systemd/system /run/systemd/system /usr/lib/systemd/system /etc/wolfpack /var/wolfpack /home/*/.env /home/*/agent/.env ${targets[@]+"${targets[@]}"}; do
      [[ -e $t ]] || continue
      refs+="$(grep -rlsF -e "$DATA_DIR/kb-mirror" -e "$KB_DIR" "$t" 2>/dev/null | grep -vx -e "$ENV_FILE" -e "$UNIT" || true)"$'\n'
    done
    refs="$(printf '%s' "$refs" | sed '/^$/d' | sort -u)"
    if [[ -n $refs ]]; then
      echo "REFUSING --purge: still referenced by: $(echo "$refs" | tr '\n' ' ')(repoint KB_BASE first)" >&2
      exit 1 # also in a dry run
    fi
  fi
  log "uninstall workerd (Hal's unit, Dewey's tree and every KB copy are never touched)"
  if ((DRY)) || systemctl cat workerd.service >/dev/null 2>&1; then run systemctl disable --now workerd.service; else echo "workerd.service not installed; skipping disable"; fi
  run rm -f "$UNIT"
  run systemctl daemon-reload
  run rm -rf "$OPT"
  if ((PURGE)); then
    echo "--purge: deleting $DATA_DIR and $KB_DIR (hub.json, outbox and the hub KB MIRROR; the mirror is a derived copy, Syncthing/Dewey KB is not affected)."
    run rm -rf "$DATA_DIR" "$KB_DIR"
    run rm -f "$ENV_FILE"
    if workerd_user_exists; then run userdel "$WU"; else echo "user $WU already gone"; fi
    if getent group "$WG" >/dev/null 2>&1; then run groupdel "$WG"; else echo "group $WG already gone"; fi
    if getent group "$KB_GROUP" >/dev/null 2>&1; then run groupdel "$KB_GROUP"; else echo "group $KB_GROUP already gone"; fi
  else
    echo "kept: $DATA_DIR (hub.json), $KB_DIR (mirror), $ENV_FILE, user $WU (use --purge to remove)"
  fi
}

"cmd_$CMD"
