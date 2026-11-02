#!/usr/bin/env bash
# Host-side release deploy (C3). Runs AS ROOT on the host; needs only bash, curl, sha256sum, GNU tar, systemctl (+ journalctl for the health check).
# Designed to be piped: `ssh host sudo bash -s -- wolfd 0.1.2 --wolf hal2 < deploy-release.sh`. All code is inside main() and `main "$@"` is the
# last line, so bash has parsed the whole script before running anything; nothing inside reads stdin (every external command gets </dev/null).
#
#   deploy-release.sh <wolfd|hubd|workerd> <X.Y.Z> [--wolf <name>] [--dry-run] [--health-timeout SEC] [--settle SEC]
#
# wolfd (needs --wolf): download -> verify sha256 -> inspect tar members -> unpack into a root-owned 0700 staging dir -> chown -> VERSION check
#   -> switch (release -> release.prev -> older prev kept as release.prev-<ver>-<ts>) -> restart wolfd@<name> -> health check -> automatic swap-back.
# hubd|workerd: same download/verify/inspect/VERSION steps, then the release's own `setup.sh install --bundle` (it keeps `previous`);
#   rollback uses the setup.sh installed by an earlier deploy ($OPT/setup.sh), or swaps current/previous itself when there is none.
# Health (wolfd): unit active, serving line `wolfd: <name> serving unix:/run/wolfd-<name>/serve.sock` in THIS invocation's journal, `-p err` empty,
#   InvocationID and NRestarts unchanged across a settle (a crash loop fails). hubd/workerd: active + same checks + the port accepts a connection.
# Exit: 0 ok / no-op, 1 refused or failed before any change, 2 usage, 3 deploy failed and rolled back, 4 failed AND rollback unhealthy / manual recovery.
# Recovery: a run that finds `release` missing (killed mid-swap) restores release.prev (or the newest release.prev-*) first.
# Test seams (DEPLOY_BASE_URL, DEPLOY_SYSTEMCTL, DEPLOY_JOURNALCTL, DEPLOY_HOME_ROOT, DEPLOY_OPT_ROOT, DEPLOY_ENV_DIR, DEPLOY_LOG) are honoured ONLY when DEPLOY_TEST=1.
# Never prints .env values or tokens.
set -uo pipefail
trap '' PIPE HUP   # an ssh disconnect must not kill a half-done switch

main() {
  local PROD_URL="https://github.com/1uk4/wolfpack/releases/download"
  local BASE_URL="$PROD_URL" HOME_ROOT=/home OPT_ROOT=/opt ENV_DIR=/etc/wolfpack LOGF=/var/log/deploy-release.log
  local SYSTEMCTL=systemctl JOURNALCTL=journalctl PROTO='=https'
  if [ "${DEPLOY_TEST:-}" = 1 ]; then
    BASE_URL="${DEPLOY_BASE_URL:-$PROD_URL}"; HOME_ROOT="${DEPLOY_HOME_ROOT:-/home}"; OPT_ROOT="${DEPLOY_OPT_ROOT:-/opt}"
    ENV_DIR="${DEPLOY_ENV_DIR:-/etc/wolfpack}"; LOGF="${DEPLOY_LOG:-$LOGF}"
    SYSTEMCTL="${DEPLOY_SYSTEMCTL:-systemctl}"; JOURNALCTL="${DEPLOY_JOURNALCTL:-journalctl}"; PROTO='=http,https'
  fi
  local COMP="" VER="" WOLF="" DRY=0 HTIMEOUT=60 SETTLE=6
  log() { echo "deploy: $*"; }
  die() { echo "deploy: REFUSED: $1" >&2; exit "${2:-1}"; }
  usage() {
    cat >&2 <<'USAGE'
usage: deploy-release.sh <wolfd|hubd|workerd> <X.Y.Z> [--wolf <name>] [--dry-run] [--health-timeout SEC] [--settle SEC]
  wolfd needs --wolf <name>; hubd/workerd must not have it. Run as root (not needed for --dry-run).
USAGE
    exit 2
  }
  sc() { "$SYSTEMCTL" "$@" </dev/null; }
  jc() { "$JOURNALCTL" "$@" </dev/null; }

  while (($#)); do
    case "$1" in
      --wolf) WOLF="${2:-}"; shift ;;
      --dry-run) DRY=1 ;;
      --health-timeout) HTIMEOUT="${2:-}"; shift ;;
      --settle) SETTLE="${2:-}"; shift ;;
      -h|--help) usage ;;
      -*) echo "deploy: unknown option $1" >&2; usage ;;
      *) if [ -z "$COMP" ]; then COMP=$1; elif [ -z "$VER" ]; then VER=$1; else usage; fi ;;
    esac
    shift
  done
  [ -n "$COMP" ] && [ -n "$VER" ] || usage
  VER="${VER#v}"
  case "$COMP" in wolfd|hubd|workerd) ;; *) die "unknown component '$COMP' (wolfd|hubd|workerd)" 2 ;; esac
  [[ $VER =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must be X.Y.Z, got '$VER'" 2
  [[ $HTIMEOUT =~ ^[0-9]+$ && $SETTLE =~ ^[0-9]+$ ]] || die "--health-timeout/--settle must be integers" 2
  local USR="" HOME_DIR="" UNIT="" REL="" PREV="" ENVF="" SOCK="" OPT="" SVC=""
  if [ "$COMP" = wolfd ]; then
    [[ $WOLF =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "wolfd needs --wolf <name> (lowercase, digits, -)" 2
    ((${#WOLF} <= 27)) || die "wolf name too long (max 27 chars: the Linux user wolf-<name> is limited to 32)" 2
    USR="wolf-$WOLF"; HOME_DIR="$HOME_ROOT/$USR"; UNIT="wolfd@$WOLF.service"
    REL="$HOME_DIR/release"; PREV="$HOME_DIR/release.prev"; ENVF="$HOME_DIR/.env"; SOCK="/run/wolfd-$WOLF/serve.sock"
    id "$USR" >/dev/null 2>&1 </dev/null || die "no Linux user $USR (provision the wolf first: infra/wolves/provision-wolf.sh)"
  else
    [ -z "$WOLF" ] || die "--wolf only applies to wolfd" 2
    SVC="$COMP.service"; OPT="$OPT_ROOT/wolfpack-$COMP"
  fi
  ((DRY)) || [ "$(id -u)" = 0 ] || die "run as root (or --dry-run)" 2

  local TAG="$COMP/v$VER" ASSET="$COMP-v$VER-linux-x64.tar.gz"
  local URL="$BASE_URL/$TAG/$ASSET"
  umask 022

  cur_version() { # <dir> -> X.Y.Z of <dir>/VERSION, or fail
    local f=$1/VERSION v; [ -f "$f" ] || return 1
    v=$(head -n1 "$f" </dev/null); [[ $v =~ ^([0-9]+\.[0-9]+\.[0-9]+) ]] || return 1
    echo "${BASH_REMATCH[1]}"
  }

  if ((DRY)); then
    log "DRY RUN for $TAG: nothing is downloaded, written or restarted"
    log "  download  $URL (+ .sha256) into a fresh mktemp -d (curl --proto =https, TLS1.2+)"
    log "  verify    sha256 file names $ASSET and its hash matches; tar members inspected (no devices/fifos, no link escaping the tree)"
    if [ "$COMP" = wolfd ]; then
      local have; have=$(cur_version "$REL" 2>/dev/null || echo none)
      [ -d "$REL" ] || [ ! -d "$HOME_DIR" ] || log "  recovery  $REL is missing: the real run restores release.prev first"
      log "  guard     refuse if $ENVF sets ANTHROPIC_API_KEY (name only reported); $HOME_DIR must be a real dir owned by $USR"
      log "  current   $have -> $VER ($([ "$have" = "$VER" ] && echo 'no-op: already running' || echo 'would deploy'))"
      log "  unpack    root-owned 0700 staging dir, chown $USR; VERSION must start with $VER"
      log "  switch    release.prev -> release.prev-<ver>-<ts> (newest 2 kept); release -> release.prev; staged -> release"
      log "  restart   systemctl restart $UNIT; health <= ${HTIMEOUT}s: serving line for the new InvocationID, no err journal, stable for ${SETTLE}s"
      log "  failure   swap back, restart, re-check, exit 3"
    else
      log "  install   bash <unpacked>/$COMP/setup.sh install --bundle <unpacked>/$COMP   (keeps 'previous'); service was-active is recorded first"
      log "  health    $SVC active, no err journal, stable for ${SETTLE}s, port accepts a connection <= ${HTIMEOUT}s; failure after the flip -> rollback, exit 3"
    fi
    exit 0
  fi

  # ---- logging (tee: survives an ssh disconnect because SIGPIPE/HUP are ignored)
  if : >>"$LOGF" 2>/dev/null; then
    local TEEOPT=""
    tee --output-error=warn-nopipe /dev/null </dev/null >/dev/null 2>&1 && TEEOPT="--output-error=warn-nopipe"
    # shellcheck disable=SC2086
    exec > >(tee -a $TEEOPT "$LOGF") 2>&1
    chmod 600 "$LOGF" 2>/dev/null || true
    log "=== $(date -u +%FT%TZ) deploy $TAG${WOLF:+ wolf=$WOLF} (log: $LOGF)"
  else
    echo "deploy: WARNING cannot write $LOGF; continuing without a log file" >&2
  fi

  command -v curl >/dev/null && command -v sha256sum >/dev/null && command -v tar >/dev/null || die "need curl, sha256sum, tar"
  local tv; tv=$(tar --version </dev/null 2>&1 | head -n1)
  [[ $tv == *"GNU tar"* ]] || die "GNU tar required to inspect archive members (got: $tv)"

  local TMP="" STAGE="" SAVED="" HAD_REL=0
  cleanup() { [ -n "$TMP" ] && rm -rf "$TMP"; [ -n "$STAGE" ] && rm -rf "$STAGE"; return 0; }
  trap cleanup EXIT

  # ---- wolfd: preconditions + crash recovery (before anything is downloaded)
  local have=""
  if [ "$COMP" = wolfd ]; then
    [ -d "$HOME_DIR" ] && [ ! -L "$HOME_DIR" ] || die "$HOME_DIR is missing or a symlink"
    [ "$(stat -c %U "$HOME_DIR")" = "$USR" ] || die "$HOME_DIR is not owned by $USR"
    [ ! -L "$REL" ] && [ ! -L "$PREV" ] || die "release / release.prev must be plain directories, not symlinks"
    [ -f "$ENVF" ] || die "$ENVF missing"
    if grep -Eq '^[[:space:]]*(export[[:space:]]+)?ANTHROPIC_API_KEY=[^[:space:]"'"'"']' "$ENVF" </dev/null; then
      die "ANTHROPIC_API_KEY is set in $ENVF; a wolfd wolf never runs on a metered key (value not shown). Remove it first."
    fi
    local lo
    for lo in "$HOME_DIR"/.release.new.* "$HOME_DIR"/.deploy-stage-"$WOLF".* "$HOME_ROOT"/.deploy-stage-"$WOLF".*; do
      [ -e "$lo" ] && { log "removing leftover $lo"; rm -rf "$lo"; }
    done
    if [ ! -e "$REL" ]; then
      local cand=""
      if [ -d "$PREV" ]; then cand=$PREV
      else
        # shellcheck disable=SC2012
        cand=$(ls -1dt "$HOME_DIR"/release.prev-* 2>/dev/null </dev/null | head -n1)
      fi
      if [ -n "$cand" ] && [ -f "$cand/launch.sh" ]; then
        log "RECOVERY: $REL is missing (an earlier run died mid-switch); restoring $(basename "$cand")"
        mv "$cand" "$REL" || { log "recovery mv failed; manual: mv $cand $REL"; exit 4; }
        sc restart "$UNIT" || log "WARNING: restart after recovery failed"
      else
        log "$REL is missing and there is nothing to recover from (first install)"
      fi
    fi
    have=$(cur_version "$REL" 2>/dev/null || true)
    if [ "$have" = "$VER" ]; then
      local st; st=$(sc is-active "$UNIT" 2>/dev/null || true)
      log "no-op: $WOLF already runs wolfd $VER; unit is ${st:-unknown}"
      [ "$st" = active ] || log "WARNING: the unit is not active. This script does not touch a running version; check: systemctl status $UNIT"
      exit 0
    fi
    log "$WOLF: ${have:-none} -> $VER"
  fi

  TMP=$(mktemp -d "${TMPDIR:-/tmp}/deploy-release.XXXXXX") || die "mktemp failed"
  fetch() { curl -fsSL --proto "$PROTO" --proto-redir "$PROTO" --tlsv1.2 --max-time 120 -o "$2" "$1" </dev/null; }
  log "download $URL"
  fetch "$URL" "$TMP/$ASSET" || die "download failed: $URL"
  fetch "$URL.sha256" "$TMP/$ASSET.sha256" || die "no $ASSET.sha256 published (refusing an unverified release)"
  [ -s "$TMP/$ASSET" ] || die "empty download"
  local line want name got
  line=$(head -n1 "$TMP/$ASSET.sha256" </dev/null)
  want=${line%% *}; name=${line##* }; name=${name#\*}
  [[ $want =~ ^[0-9a-f]{64}$ ]] || die "malformed .sha256 file"
  [ "$name" = "$ASSET" ] || die "component/version mismatch: .sha256 names '$name', expected '$ASSET'"
  got=$(sha256sum "$TMP/$ASSET" </dev/null | cut -d' ' -f1)
  [ "$got" = "$want" ] || die "sha256 mismatch for $ASSET (expected ${want:0:12}…, got ${got:0:12}…)"
  log "sha256 ok ${want:0:12}…"

  # ---- member inspection (GNU tar listing). Real releases DO contain relative symlinks (node_modules/.bin -> ../x) and hardlinks (esbuild),
  # so links are validated, not banned: no devices/fifos/sockets; a symlink must be relative and stay inside the tree; a hardlink must name an
  # EARLIER regular member of the same archive; no member may be written beneath a symlink; no absolute or `..` member names; no escaped/odd names.
  local listing verdict
  listing=$(tar --quoting-style=escape --numeric-owner -tvzf "$TMP/$ASSET" </dev/null) || die "cannot list the tarball"
  verdict=$(printf '%s\n' "$listing" | awk '
    function bad(m) { print "BAD: " m; exit 1 }
    function resolve(dir, t,   p, n, i, st, sp, seg, out) {
      if (t ~ /^\//) return "!"
      n = split(dir "/" t, p, "/"); sp = 0
      for (i = 1; i <= n; i++) { seg = p[i]
        if (seg == "" || seg == ".") continue
        if (seg == "..") { if (sp == 0) return "!"; sp-- } else st[++sp] = seg }
      out = ""; for (i = 1; i <= sp; i++) out = out (i > 1 ? "/" : "") st[i]
      return out
    }
    {
      t = substr($0, 1, 1)
      if (t == "c" || t == "b" || t == "p" || t == "s") bad("device/fifo/socket member")
      line = $0; sub(/^[^ ]+ +[^ ]+ +[^ ]+ +[^ ]+ +[^ ]+ /, "", line)
      if (line ~ /\\/) bad("member name with escaped or control characters")
      name = line; target = ""
      if (t == "l") { i = index(line, " -> "); if (!i) bad("unparsable symlink line"); name = substr(line, 1, i - 1); target = substr(line, i + 4) }
      else if (t == "h") { i = index(line, " link to "); if (!i) bad("unparsable hardlink line"); name = substr(line, 1, i - 1); target = substr(line, i + 9) }
      else if (index(name, " -> ") || index(name, " link to ")) bad("member name looks like a link line")
      sub(/^\.\//, "", name); sub(/\/$/, "", name)
      if (name == "" || name == ".") next
      if (name ~ /^\// || name ~ /(^|\/)\.\.(\/|$)/) bad("absolute or parent-relative member name")
      n = split(name, pp, "/"); pre = ""
      for (j = 1; j < n; j++) { pre = pre (j > 1 ? "/" : "") pp[j]; if (pre in sym) bad("member written beneath a symlink") }
      if (t == "l") {
        dir = name; if (dir ~ /\//) sub(/\/[^\/]*$/, "", dir); else dir = ""
        if (resolve(dir, target) == "!") bad("symlink target is absolute or escapes the tree")
        sym[name] = 1
      } else if (t == "h") {
        tn = target; sub(/^\.\//, "", tn)
        if (tn ~ /^\// || tn ~ /(^|\/)\.\.(\/|$)/ || !(tn in files)) bad("hardlink target is not an earlier member of this archive")
        files[name] = 1
      } else if (t == "-") files[name] = 1
    }
    END { print "OK" }') || true
  [ "$verdict" = OK ] || die "unsafe tar member (${verdict#BAD: })"

  # ---- stage: root-owned 0700, same filesystem as the wolf home when possible, then chown and rename into place
  if [ "$COMP" = wolfd ]; then
    local sd; sd=$(stat -c %d "$HOME_ROOT" </dev/null)
    if [ "$sd" = "$(stat -c %d "$HOME_DIR" </dev/null)" ]; then
      STAGE=$(mktemp -d "$HOME_ROOT/.deploy-stage-$WOLF.XXXXXX")
    else
      STAGE=$(mktemp -d "$HOME_DIR/.deploy-stage-$WOLF.XXXXXX")
    fi
    [ -n "$STAGE" ] && [ -d "$STAGE" ] || die "cannot create a staging dir"
    chmod 700 "$STAGE"
    local X="$STAGE/rel"; mkdir "$X"
  else
    STAGE=$(mktemp -d "${TMPDIR:-/tmp}/deploy-stage.XXXXXX") || die "mktemp failed"
    chmod 700 "$STAGE"; local X="$STAGE/x"; mkdir "$X"
  fi
  tar -xzf "$TMP/$ASSET" --no-same-owner --no-same-permissions --no-overwrite-dir -C "$X" </dev/null || die "unpack failed"
  [ -z "$(find "$X" ! -type f ! -type d ! -type l -print -quit </dev/null)" ] || die "unpacked tree has special files"
  check_version() { # <dir>
    [ -f "$1/VERSION" ] || die "VERSION missing in the release"
    local v; v=$(head -n1 "$1/VERSION" </dev/null)
    [ "${v%%+*}" = "$VER" ] || die "VERSION mismatch: tarball says '$v', requested $VER"
  }

  # ======================================================================== hubd / workerd
  if [ "$COMP" != wolfd ]; then
    local B="$X/$COMP"
    [ -f "$B/setup.sh" ] || die "$COMP/setup.sh not in the release"
    check_version "$B"
    chmod -R u-s,g-s "$X"
    local was_active=0 cur_before="" cur_after="" flipped=0 irc=0 since
    sc is-active --quiet "$SVC" 2>/dev/null && was_active=1
    cur_before=$(readlink -f "$OPT/current" 2>/dev/null || true)
    log "$SVC was $([ $was_active = 1 ] && echo active || echo NOT active) before the deploy"
    log "setup.sh install (keeps previous for rollback)"
    bash "$B/setup.sh" install --bundle "$B" </dev/null || irc=$?
    cur_after=$(readlink -f "$OPT/current" 2>/dev/null || true)
    [ "$cur_before" != "$cur_after" ] && flipped=1
    if [ $irc != 0 ] && [ $flipped = 0 ]; then
      log "install failed (rc=$irc) and $OPT/current did not change: the old release is still live; nothing to roll back"; exit 1
    fi
    [ $irc = 0 ] || log "install exited rc=$irc AFTER flipping $OPT/current: treating the deploy as failed"

    hub_port_ok() {
      local f="$ENV_DIR/$COMP.env" h p
      if [ ! -r "$f" ]; then log "note: $f not readable; listening check skipped"; return 0; fi
      h=$(sed -n "s/^${COMP^^}_HOST=//p" "$f" </dev/null | tail -n1); p=$(sed -n "s/^${COMP^^}_PORT=//p" "$f" </dev/null | tail -n1)
      [[ $h =~ ^[0-9.]+$ && $p =~ ^[0-9]+$ ]] || { log "note: no usable host/port in $f; listening check skipped"; return 0; }
      (exec 3<>"/dev/tcp/$h/$p") 2>/dev/null </dev/null || { log "nothing is listening on $h:$p"; return 1; }
    }
    hub_healthy() {
      local t=0 iid iid2 nr1 nr2 errs
      while ((t <= HTIMEOUT)); do
        if sc is-active --quiet "$SVC" 2>/dev/null; then
          iid=$(sc show -p InvocationID --value "$SVC" 2>/dev/null || true); nr1=$(sc show -p NRestarts --value "$SVC" 2>/dev/null || true)
          sleep "$SETTLE"
          sc is-active --quiet "$SVC" 2>/dev/null || { log "$SVC died during settle"; return 1; }
          iid2=$(sc show -p InvocationID --value "$SVC" 2>/dev/null || true); nr2=$(sc show -p NRestarts --value "$SVC" 2>/dev/null || true)
          [ "$iid" = "$iid2" ] && [ "$nr1" = "$nr2" ] || { log "$SVC restarted during settle (crash loop)"; return 1; }
          if [ -n "$iid" ]; then errs=$(jc "_SYSTEMD_INVOCATION_ID=$iid" -p err --no-pager -q 2>/dev/null || true)
          else errs=$(jc -u "$SVC" -p err --since "@$since" --no-pager -q 2>/dev/null || true); fi
          [ -z "$errs" ] || { log "journal has errors for this invocation"; return 1; }
          hub_port_ok || return 1
          return 0
        fi
        sleep 1; t=$((t + 1))
      done
      log "$SVC not active within ${HTIMEOUT}s"; return 1
    }
    hub_rollback() {
      if [ -f "$OPT/setup.sh" ]; then
        log "rollback via the installed $OPT/setup.sh"; bash "$OPT/setup.sh" rollback </dev/null && return 0
        log "installed setup.sh rollback failed; swapping links myself"
      else
        log "no installed setup.sh yet; swapping $OPT/current and previous myself"
      fi
      local cur prev
      [ -L "$OPT/previous" ] || { log "no $OPT/previous"; return 1; }
      cur=$(readlink -f "$OPT/current"); prev=$(readlink -f "$OPT/previous")
      ln -sfn "$prev" "$OPT/current.new" && mv -T "$OPT/current.new" "$OPT/current" || return 1
      ln -sfn "$cur" "$OPT/previous.new" && mv -T "$OPT/previous.new" "$OPT/previous" || return 1
    }
    since=$(date +%s)
    if [ $irc = 0 ] && [ $was_active = 0 ]; then
      log "$SVC was not running before this deploy and is left stopped: installed $VER, no health check possible. Start it when ready: systemctl start $SVC"
      install -m 0755 "$B/setup.sh" "$OPT/setup.sh" 2>/dev/null || true
      exit 0
    fi
    if [ $irc = 0 ] && hub_healthy; then
      install -m 0755 "$B/setup.sh" "$OPT/setup.sh" || log "note: could not save $OPT/setup.sh (rollback will swap links itself)"
      log "OK: $COMP $VER deployed and healthy"; exit 0
    fi
    log "FAILED; rolling back"
    hub_rollback || { log "ROLLBACK FAILED: $COMP needs a human (see $OPT/current and previous)"; exit 4; }
    if [ $was_active = 0 ]; then log "$SVC was stopped before the deploy; rolled back and left stopped"; exit 3; fi
    sleep 1; since=$(date +%s)
    sc restart "$SVC" || log "restart after rollback failed"
    if hub_healthy; then log "rolled back; $COMP healthy again"; exit 3; fi
    log "ROLLBACK UNHEALTHY: $SVC needs a human"; exit 4
  fi

  # ======================================================================== wolfd
  check_version "$X"
  [ -f "$X/launch.sh" ] || die "launch.sh not in the release"
  chmod +x "$X/launch.sh"
  chown -R -h "$USR:$USR" "$X" || die "chown failed"
  chmod -R u-s,g-s "$X" || die "chmod failed"
  log "staged $(head -n1 "$X/VERSION" </dev/null) (owner $USR); nothing has changed yet"

  local TS pv oldver
  TS=$(date -u +%Y%m%dT%H%M%SZ)
  oldver=${have:-none}
  if [ -d "$PREV" ]; then
    pv=$(cur_version "$PREV" 2>/dev/null || true); [ -n "$pv" ] || pv=unknown
    SAVED="$HOME_DIR/release.prev-$pv-$TS"
  fi
  # -------- the switch: three renames, each checked
  if [ -n "$SAVED" ]; then mv "$PREV" "$SAVED" || die "cannot set aside $PREV (nothing changed)"; fi
  if [ -d "$REL" ]; then
    HAD_REL=1
    mv "$REL" "$PREV" || { [ -n "$SAVED" ] && mv "$SAVED" "$PREV"; die "cannot move $REL aside (nothing changed)"; }
  fi
  if ! mv "$X" "$REL"; then
    log "FATAL: cannot move the staged release into place"
    [ $HAD_REL = 1 ] && { mv "$PREV" "$REL" || { log "manual: mv $PREV $REL"; exit 4; }; }
    [ -n "$SAVED" ] && { mv "$SAVED" "$PREV" || log "manual: mv $SAVED $PREV"; }
    exit 4
  fi
  log "switched: release=$VER, release.prev=$oldver${SAVED:+ (older prev kept as $(basename "$SAVED"))}"

  local SINCE=0
  wolf_healthy() { # <timeout>
    local to=$1 t=0 iid iid2 nr1 nr2 st jl errs
    SINCE=$(date +%s)
    sc reset-failed "$UNIT" >/dev/null 2>&1 || true
    sc restart "$UNIT" || { log "systemctl restart failed"; return 1; }
    iid=$(sc show -p InvocationID --value "$UNIT" 2>/dev/null || true)
    jlog() { if [ -n "$iid" ]; then jc "_SYSTEMD_INVOCATION_ID=$iid" --no-pager -q "$@" 2>/dev/null; else jc -u "$UNIT" --since "@$SINCE" --no-pager -q "$@" 2>/dev/null; fi; }
    while ((t <= to)); do
      st=$(sc is-active "$UNIT" 2>/dev/null || true)
      [ "$st" = failed ] && { log "unit is failed"; return 1; }
      if [ "$st" = active ]; then
        jl=$(jlog || true)
        if [[ $jl == *"wolfd: $WOLF serving unix:$SOCK"* ]]; then
          nr1=$(sc show -p NRestarts --value "$UNIT" 2>/dev/null || true)
          sleep "$SETTLE"
          [ "$(sc is-active "$UNIT" 2>/dev/null || true)" = active ] || { log "unit died during settle"; return 1; }
          iid2=$(sc show -p InvocationID --value "$UNIT" 2>/dev/null || true); nr2=$(sc show -p NRestarts --value "$UNIT" 2>/dev/null || true)
          [ "$iid" = "$iid2" ] && [ "$nr1" = "$nr2" ] || { log "unit restarted during settle (crash loop)"; return 1; }
          errs=$(jlog -p err || true)
          [ -z "$errs" ] || { log "journal has errors since the restart"; return 1; }
          return 0
        fi
      fi
      sleep 1; t=$((t + 1))
    done
    log "no serving line within ${to}s (unit ${st:-unknown})"; return 1
  }
  prune() { # keep the newest 2 of release.prev-* and release.failed-*
    local pat d
    for pat in release.prev- release.failed-; do
      # shellcheck disable=SC2012
      ls -1dt "$HOME_DIR/$pat"* 2>/dev/null </dev/null | tail -n +3 | while read -r d; do rm -rf "$d"; done
    done
  }

  if wolf_healthy "$HTIMEOUT"; then
    prune
    log "OK: $UNIT runs wolfd $VER (previous $oldver kept in release.prev)"
    exit 0
  fi
  log "FAILED: rolling back to $oldver"
  local BAD="$HOME_DIR/release.failed-$VER-$TS"
  mv "$REL" "$BAD" || { log "FATAL: cannot move the failed release aside; manual: swap $REL and $PREV"; exit 4; }
  if [ $HAD_REL = 1 ]; then mv "$PREV" "$REL" || { log "FATAL: cannot restore; manual: mv $PREV $REL"; exit 4; }; fi
  if [ -n "$SAVED" ]; then mv "$SAVED" "$PREV" || log "WARNING: could not restore the older prev; manual: mv $SAVED $PREV"; fi
  log "failed release kept for inspection at $BAD"
  if [ $HAD_REL = 0 ]; then log "no previous release to restore; $UNIT is down"; exit 4; fi
  sleep 1   # journalctl --since has 1 s resolution
  if wolf_healthy "$HTIMEOUT"; then prune; log "rolled back: $UNIT healthy on $oldver"; exit 3; fi
  log "ROLLBACK UNHEALTHY: $UNIT needs a human"; exit 4
}

main "$@"
