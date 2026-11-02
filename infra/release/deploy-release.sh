#!/usr/bin/env bash
# Host-side release deploy (C3). Runs AS ROOT on the host; needs only bash, curl, sha256sum, tar, systemctl (journalctl for the health check).
#   deploy-release.sh <wolfd|hubd|workerd> <X.Y.Z> [--wolf <name>] [--dry-run] [--health-timeout SEC] [--settle SEC]
# wolfd (needs --wolf): download -> verify sha256 -> unpack beside /home/wolf-<name>/release -> VERSION check -> release -> release.prev
#   (an older prev is kept as release.prev-<ver>-<ts>, never deleted) -> restart wolfd@<name> -> health check -> automatic swap-back on failure.
# hubd|workerd: same download/verify/VERSION steps, then `setup.sh install --bundle` from the release itself (it keeps `previous`);
#   on a failed health check `setup.sh rollback`. See deploy/{hubd,workerd}/RUNBOOK.md.
# Health (wolfd): unit active, `journalctl -p err` empty since the restart, and the journal shows `wolfd: <name> serving unix:/run/wolfd-<name>/serve.sock`.
# Exit: 0 ok / no-op, 1 refused or failed before any change, 2 usage, 3 deploy failed and rolled back, 4 deploy failed AND rollback unhealthy.
# Test seams (env): DEPLOY_BASE_URL (default the GitHub releases URL), DEPLOY_HOME_ROOT (/home), SYSTEMCTL, JOURNALCTL.
# Never prints .env values or tokens.
set -uo pipefail
BASE_URL="${DEPLOY_BASE_URL:-https://github.com/1uk4/wolfpack/releases/download}"
HOME_ROOT="${DEPLOY_HOME_ROOT:-/home}"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
JOURNALCTL="${JOURNALCTL:-journalctl}"
COMP="" VER="" WOLF="" DRY=0 HTIMEOUT=60 SETTLE=3
log() { echo "deploy: $*"; }
die() { echo "deploy: REFUSED: $*" >&2; exit "${2:-1}"; }
usage() { sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
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
if [ "$COMP" = wolfd ]; then
  [[ $WOLF =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "wolfd needs --wolf <name> (lowercase, digits, -)" 2
else
  [ -z "$WOLF" ] || die "--wolf only applies to wolfd" 2
fi
((DRY)) || [ "$(id -u)" = 0 ] || die "run as root (or --dry-run)" 2

TAG="$COMP/v$VER"
ASSET="$COMP-v$VER-linux-x64.tar.gz"
URL="$BASE_URL/$TAG/$ASSET"
if [ "$COMP" = wolfd ]; then
  USR="wolf-$WOLF"; HOME_DIR="$HOME_ROOT/$USR"; UNIT="wolfd@$WOLF.service"
  REL="$HOME_DIR/release"; PREV="$HOME_DIR/release.prev"; ENVF="$HOME_DIR/.env"
  SOCK="/run/wolfd-$WOLF/serve.sock"
fi

cur_version() { local f=$1/VERSION v; [ -f "$f" ] || return 1; v=$(head -n1 "$f"); echo "${v%%+*}"; }

if ((DRY)); then
  log "DRY RUN for $TAG: nothing is downloaded, written or restarted"
  log "  download  $URL (+ .sha256)  into a fresh mktemp -d"
  log "  verify    sha256 file names $ASSET and its hash matches; refuse otherwise"
  if [ "$COMP" = wolfd ]; then
    log "  guard     refuse if $ENVF sets ANTHROPIC_API_KEY (name only reported)"
    log "  current   $(cur_version "$REL" 2>/dev/null || echo 'none (first install)') -> $VER ($( [ "$(cur_version "$REL" 2>/dev/null)" = "$VER" ] && echo 'no-op: already running' || echo 'would deploy'))"
    log "  unpack    $HOME_DIR/.release.new.* (chown $USR:$USR); VERSION must start with $VER"
    log "  switch    release.prev -> release.prev-<ver>-<ts> (kept); release -> release.prev; new -> release"
    log "  restart   $SYSTEMCTL restart $UNIT; health <= ${HTIMEOUT}s: active, no journal errors, '$SOCK' serving line"
    log "  failure   swap back, restart, re-check, exit 3"
  else
    log "  unpack    tar into the temp dir; $COMP/VERSION must start with $VER"
    log "  install   bash <unpacked>/$COMP/setup.sh install --bundle <unpacked>/$COMP   (keeps 'previous')"
    log "  health    $COMP.service active, no journal errors <= ${HTIMEOUT}s; failure -> setup.sh rollback, exit 3"
  fi
  exit 0
fi

command -v curl >/dev/null && command -v sha256sum >/dev/null && command -v tar >/dev/null || die "need curl, sha256sum, tar"

if [ "$COMP" = wolfd ]; then
  [ -d "$HOME_DIR" ] || die "$HOME_DIR does not exist (provision the wolf first: infra/wolves/provision-wolf.sh)"
  [ -f "$ENVF" ] || die "$ENVF missing"
  if grep -Eq '^[[:space:]]*(export[[:space:]]+)?ANTHROPIC_API_KEY=[^[:space:]"'"'"']' "$ENVF"; then
    die "ANTHROPIC_API_KEY is set in $ENVF; a wolfd wolf never runs on a metered key (value not shown). Remove it first."
  fi
  have=$(cur_version "$REL" 2>/dev/null || true)
  if [ "$have" = "$VER" ]; then
    log "no-op: $WOLF already runs wolfd $VER ($(head -n1 "$REL/VERSION")); unit $($SYSTEMCTL is-active "$UNIT" 2>/dev/null || true)"
    exit 0
  fi
  log "$WOLF: ${have:-none} -> $VER"
fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/deploy-release.XXXXXX") || die "mktemp failed"
NEW=""
cleanup() { rm -rf "$TMP"; [ -n "$NEW" ] && rm -rf "$NEW"; return 0; }
trap cleanup EXIT

log "download $URL"
curl -fsSL -o "$TMP/$ASSET" "$URL" || die "download failed: $URL"
curl -fsSL -o "$TMP/$ASSET.sha256" "$URL.sha256" || die "no $ASSET.sha256 published (refusing an unverified release)"
[ -s "$TMP/$ASSET" ] || die "empty download"
line=$(head -n1 "$TMP/$ASSET.sha256")
want=${line%% *}; name=${line##* }; name=${name#\*}
[[ $want =~ ^[0-9a-f]{64}$ ]] || die "malformed .sha256 file"
[ "$name" = "$ASSET" ] || die "component/version mismatch: .sha256 names '$name', expected '$ASSET'"
got=$(sha256sum "$TMP/$ASSET" | cut -d' ' -f1)
[ "$got" = "$want" ] || die "sha256 mismatch for $ASSET (expected ${want:0:12}…, got ${got:0:12}…)"
log "sha256 ok ${want:0:12}…"
# no absolute or parent-relative members
if tar -tzf "$TMP/$ASSET" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then die "tarball has unsafe paths"; fi

check_version() { # <dir>
  [ -f "$1/VERSION" ] || die "$1/VERSION missing in the release"
  local v; v=$(head -n1 "$1/VERSION")
  [ "${v%%+*}" = "$VER" ] || die "VERSION mismatch: tarball says '$v', requested $VER"
}

# ---------------------------------------------------------------- hubd / workerd
if [ "$COMP" != wolfd ]; then
  mkdir "$TMP/x" && tar -xzf "$TMP/$ASSET" --no-same-owner -C "$TMP/x" || die "unpack failed"
  B="$TMP/x/$COMP"
  [ -f "$B/setup.sh" ] || die "$COMP/setup.sh not in the release"
  check_version "$B"
  since=$(date +%s)
  log "setup.sh install (keeps previous for rollback)"
  bash "$B/setup.sh" install --bundle "$B" || { log "install failed; setup.sh left the old release live"; exit 1; }
  healthy_host() {
    local t=0
    while ((t <= HTIMEOUT)); do
      if $SYSTEMCTL is-active --quiet "$COMP.service" 2>/dev/null; then
        sleep "$SETTLE"
        $SYSTEMCTL is-active --quiet "$COMP.service" 2>/dev/null && [ -z "$($JOURNALCTL -u "$COMP.service" -p err --since "@$since" --no-pager -q 2>/dev/null)" ] && return 0
        return 1
      fi
      sleep 1; t=$((t + 1))
    done
    return 1
  }
  if healthy_host; then log "OK: $COMP $VER deployed and healthy"; exit 0; fi
  log "FAILED health check; rolling back with setup.sh rollback"
  bash "$B/setup.sh" rollback || log "rollback command failed"
  since=$(date +%s); sleep 1
  if healthy_host; then log "rolled back; $COMP healthy again"; exit 3; fi
  log "ROLLBACK UNHEALTHY: $COMP.service needs a human"; exit 4
fi

# ---------------------------------------------------------------- wolfd
NEW="$HOME_DIR/.release.new.$$"
rm -rf "$NEW"; mkdir "$NEW" || die "cannot create $NEW"
tar -xzf "$TMP/$ASSET" --no-same-owner -C "$NEW" || die "unpack failed"
check_version "$NEW"
[ -f "$NEW/launch.sh" ] || die "launch.sh not in the release"
chmod +x "$NEW/launch.sh"
chown -R "$USR:$USR" "$NEW" || die "chown failed"
log "unpacked $(head -n1 "$NEW/VERSION") beside $REL"

TS=$(date -u +%Y%m%dT%H%M%SZ)
OLDVER=${have:-none}
SAVED=""                                  # an older release.prev moved aside
if [ -d "$PREV" ]; then
  pv=$(cur_version "$PREV" 2>/dev/null || echo unknown)
  SAVED="$PREV-$pv-$TS"
  mv "$PREV" "$SAVED" || die "cannot set aside $PREV"
fi
HAD_REL=0
if [ -d "$REL" ]; then HAD_REL=1; mv "$REL" "$PREV" || die "cannot move $REL"; fi
mv "$NEW" "$REL" || { [ $HAD_REL = 1 ] && mv "$PREV" "$REL"; [ -n "$SAVED" ] && mv "$SAVED" "$PREV"; die "switch failed (restored)"; }
NEW=""
log "switched: release=$VER, release.prev=$OLDVER${SAVED:+ (older prev kept as $(basename "$SAVED"))}"

wolf_healthy() { # <timeout>  -> 0 healthy
  local to=$1 t=0 since st
  since=$(date +%s)
  $SYSTEMCTL reset-failed "$UNIT" >/dev/null 2>&1 || true
  $SYSTEMCTL restart "$UNIT" || { log "systemctl restart failed"; return 1; }
  while ((t <= to)); do
    st=$($SYSTEMCTL is-active "$UNIT" 2>/dev/null || true)
    [ "$st" = failed ] && { log "unit is failed"; return 1; }
    if [ "$st" = active ] && $JOURNALCTL -u "$UNIT" --since "@$since" --no-pager -q 2>/dev/null | grep -qF "wolfd: $WOLF serving unix:$SOCK"; then
      sleep "$SETTLE"
      [ "$($SYSTEMCTL is-active "$UNIT" 2>/dev/null || true)" = active ] || { log "unit died during settle"; return 1; }
      if [ -n "$($JOURNALCTL -u "$UNIT" -p err --since "@$since" --no-pager -q 2>/dev/null)" ]; then log "journal has errors since restart"; return 1; fi
      return 0
    fi
    sleep 1; t=$((t + 1))
  done
  log "no serving line within ${to}s (unit $st)"
  return 1
}

if wolf_healthy "$HTIMEOUT"; then
  log "OK: $UNIT runs wolfd $VER (previous $OLDVER kept in release.prev)"
  exit 0
fi
log "FAILED: rolling back to $OLDVER"
BAD="$HOME_DIR/release.failed-$VER-$TS"
mv "$REL" "$BAD"
if [ $HAD_REL = 1 ]; then mv "$PREV" "$REL"; fi
[ -n "$SAVED" ] && mv "$SAVED" "$PREV"
log "failed release kept for inspection at $BAD"
sleep 1   # journal --since has 1 s resolution: keep the failed run's lines out of the re-check
if [ $HAD_REL = 0 ]; then log "no previous release to restore; $UNIT is down"; exit 4; fi
if wolf_healthy "$HTIMEOUT"; then log "rolled back: $UNIT healthy on $OLDVER"; exit 3; fi
log "ROLLBACK UNHEALTHY: $UNIT needs a human"; exit 4
