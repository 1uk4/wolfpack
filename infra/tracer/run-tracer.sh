#!/usr/bin/env bash
# Tracer runner (local Docker). Foreground, bounded, one result file. NEVER poll it: run it in the foreground and read infra/tracer/out/result.txt.
#   infra/tracer/run-tracer.sh [MODE] [--ref <branch|sha>]     (default ref HEAD)
#   MODE: (none)=stub scripted model, --kb, --ro-work (kb + read-only work dirs), --console (browser round-trip), --max (real wolfd + claude, Max token)
#   --build-only   ensure the base, build the per-run image and keep it tagged $TRACER_IMAGE (default wolfpack-tracer) for durability.sh / sim scripts.
# Steps: lock -> preflight -> [base-build, only if wolfpack-tracer-base:<hash> is missing] -> build (git archive export, never the working tree) -> run-<mode>.
# Env: TRACER_TIMEOUT_{PREFLIGHT,BASE,BUILD,RUN} (seconds; defaults 60/1800/600/mode-specific), TRACER_MIN_FREE_GB (10), TRACER_OUT (result dir),
#      TRACER_LOCK_DIR, TRACER_DOCKER_ARGS. Test seams: TRACER_TEST_BREAK_APT=1 (forces the base apt check with a broken keyring).
# Portable: bash 3.2 (macOS), no flock/timeout needed. Exit code: 0 PASS, 1 FAIL, 2 usage/lock refused.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${TRACER_OUT:-$ROOT/infra/tracer/out}"; mkdir -p "$OUT"
MODE=stub; MODEFLAG=""; REF=HEAD; BUILD_ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="${2:?--ref needs a value}"; shift;;
    --kb) MODE=kb; MODEFLAG=--kb;; --ro-work) MODE=ro-work; MODEFLAG=--ro-work;; --console) MODE=console; MODEFLAG=--console;; --max) MODE=max; MODEFLAG=--max;;
    --build-only) BUILD_ONLY=1;;
    *) echo "run-tracer: unknown argument $1" >&2; exit 2;;
  esac; shift
done
TS="$(date +%Y%m%d-%H%M%S)"; LOG="$OUT/run-$TS.log"; START=$(date +%s)
LOCK_DIR="${TRACER_LOCK_DIR:-$HOME/.wolfpack/run/tracer.lock}"
RUN_ID="$$"; CNAME="wolfpack-tracer-run-$RUN_ID"; RUN_IMAGE="${TRACER_IMAGE:-wolfpack-tracer}-run-$RUN_ID"
EXPORT=""; HAVE_LOCK=""; STEP=init; RESULT=FAIL; REASON=""; COMMIT="-"; BUILD_S=0; BASE_S=0; BASE_TAG=""; TOK_TMP=""
log() { printf '%s\n' "$*" | tee -a "$LOG"; }
finish() {
  rc=$?; trap - EXIT
  [ "$RESULT" = PASS ] && rc=0
  docker rm -f "$CNAME" >/dev/null 2>&1
  [ -n "$BUILD_ONLY" ] && [ "$RESULT" = PASS ] || docker rmi "$RUN_IMAGE" >/dev/null 2>&1   # per-run image only; the base and other images are never touched
  [ -z "$TOK_TMP" ] || rm -f "$TOK_TMP"; [ -z "$EXPORT" ] || rm -rf "$EXPORT"
  [ -z "$HAVE_LOCK" ] || rm -rf "$LOCK_DIR"
  dur=$(( $(date +%s) - START ))
  fstep="-"; [ "$RESULT" = PASS ] || fstep="$STEP"
  line="$RESULT mode=$MODE ref=$REF commit=$COMMIT step=$fstep duration=${dur}s base_build=${BASE_S}s build=${BUILD_S}s log=$LOG"
  [ -z "$REASON" ] || line="$line reason=\"$REASON\""
  printf '%s\n' "$line" > "$OUT/result.txt"
  printf '{"result":"%s","mode":"%s","ref":"%s","commit":"%s","failingStep":"%s","durationSec":%s,"baseBuildSec":%s,"buildSec":%s,"reason":"%s","log":"%s"}\n' \
    "$RESULT" "$MODE" "$REF" "$COMMIT" "$fstep" "$dur" "$BASE_S" "$BUILD_S" "$(printf '%s' "$REASON" | tr '"\\' "''")" "$LOG" > "$OUT/result.json"
  printf 'TRACER %s\n' "$line"
  [ "$RESULT" = PASS ] && exit 0; [ "$rc" = 0 ] && rc=1; exit "$rc"
}
trap finish EXIT
fail() { REASON="$1"; log "FAIL at step '$STEP': $1"; exit "${2:-1}"; }

# run_step <name> <limit-seconds> <kill-cmd-or-empty> <command...>: runs in the background with a watchdog; on timeout kills it and fails with the step name.
run_step() {
  STEP="$1"; local limit="$2" killcmd="$3"; shift 3; local flag="$OUT/.timeout.$RUN_ID" pid wd rc
  rm -f "$flag"
  "$@" & pid=$!
  ( sleep "$limit" || exit 0; : > "$flag"; [ -z "$killcmd" ] || eval "$killcmd"; kill "$pid" 2>/dev/null ) >/dev/null 2>&1 & wd=$!
  wait "$pid"; rc=$?
  pkill -P "$wd" 2>/dev/null; kill "$wd" 2>/dev/null; wait "$wd" 2>/dev/null
  if [ -f "$flag" ]; then rm -f "$flag"; fail "step '$STEP' exceeded its ${limit}s limit and was killed"; fi
  return $rc
}

# ---- lock (mkdir is atomic; stale = recorded pid is dead) ----
mkdir -p "$(dirname "$LOCK_DIR")"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  opid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [ -n "$opid" ] && kill -0 "$opid" 2>/dev/null; then
    STEP=lock; fail "another tracer run holds $LOCK_DIR (pid $opid, $(cat "$LOCK_DIR/info" 2>/dev/null)); not starting a second one" 2
  fi
  echo "run-tracer: taking over stale lock (pid '${opid:-?}' is dead)" | tee -a "$LOG"
  rm -rf "$LOCK_DIR"; mkdir "$LOCK_DIR" 2>/dev/null || { STEP=lock; fail "lost the race for $LOCK_DIR" 2; }
fi
HAVE_LOCK=1; echo "$$" > "$LOCK_DIR/pid"; echo "mode=$MODE ref=$REF started=$TS" > "$LOCK_DIR/info"
log "== run-tracer mode=$MODE ref=$REF log=$LOG"

# ---- export (clean git archive; never the working tree) ----
STEP=export
COMMIT="$(git -C "$ROOT" rev-parse --verify --short=12 "$REF^{commit}" 2>/dev/null)" || fail "ref '$REF' not found in $ROOT"
EXPORT="$(mktemp -d "${TMPDIR:-/tmp}/wolfpack-tracer-export.XXXXXX")"
git -C "$ROOT" archive "$REF" | tar -x -C "$EXPORT" || fail "git archive $REF failed"
[ -f "$EXPORT/infra/tracer/Dockerfile.base" ] || fail "ref $REF has no infra/tracer/Dockerfile.base"
if [ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null | grep -v '^??' | head -1)" ] && [ "$REF" = HEAD ]; then log "note: working tree has uncommitted changes; only commit $COMMIT is tested"; fi
BASE_HASH="$(shasum -a 256 "$EXPORT/infra/tracer/Dockerfile.base" | cut -c1-12)"; BASE_TAG="wolfpack-tracer-base:$BASE_HASH"
UPSTREAM="$(sed -n 's/^FROM \(node:[^ ]*\).*/\1/p' "$EXPORT/infra/tracer/Dockerfile.base" | head -1)"
NEED_BASE=""; docker image inspect "$BASE_TAG" >/dev/null 2>&1 || NEED_BASE=1
[ -z "${TRACER_TEST_BREAK_APT:-}" ] || NEED_BASE=1

# ---- preflight (<= 60s total by default) ----
PF="${TRACER_TIMEOUT_PREFLIGHT:-60}"
run_step preflight-docker "$PF" "" docker info >/dev/null 2>&1 || fail "Docker is not reachable (is Docker Desktop running?)"
MIN="${TRACER_MIN_FREE_GB:-10}"; PFIMG="$BASE_TAG"; [ -z "$NEED_BASE" ] || PFIMG="$UPSTREAM"
docker image inspect "$PFIMG" >/dev/null 2>&1 || run_step preflight-pull "$PF" "" docker pull -q "$PFIMG" >/dev/null 2>&1 || fail "cannot pull $PFIMG for the preflight (network?)"
run_step preflight-disk "$PF" "" docker run --rm --entrypoint df "$PFIMG" -Pk / > "$OUT/.df.$RUN_ID" 2>&1 || fail "cannot read free space in the Docker VM"
FREE_KB="$(awk 'NR==2{print $4}' "$OUT/.df.$RUN_ID")"; rm -f "$OUT/.df.$RUN_ID"
FREE_GB=$(( ${FREE_KB:-0} / 1048576 ))
log "preflight: Docker VM free ${FREE_GB} GB (min ${MIN})"
[ "$FREE_GB" -ge "$MIN" ] || fail "Docker VM has only ${FREE_GB} GB free (< ${MIN} GB). Prune build cache and dangling images ('docker builder prune -f; docker image prune -f') or enlarge the Docker disk" 
if [ -n "$NEED_BASE" ]; then
  # apt signature check: with the pinned upstream image, 'apt-get update' must succeed with signatures verified (no insecure fallback).
  # Seam: TRACER_TEST_BREAK_APT=1 deletes the Debian keyring first, which must make the check fail.
  brk=""; [ -z "${TRACER_TEST_BREAK_APT:-}" ] || brk='rm -f /usr/share/keyrings/debian-archive-keyring.gpg /etc/apt/trusted.gpg.d/* ;'
  run_step preflight-apt "$PF" "" docker run --rm --entrypoint sh "$UPSTREAM" -c "$brk apt-get update 2>&1 | tee /tmp/apt.out; ! grep -Eqi 'NO_PUBKEY|not signed|signatures couldn|GPG error|invalid signature' /tmp/apt.out && grep -q '^Get:\|^Hit:' /tmp/apt.out" > "$OUT/.apt.$RUN_ID" 2>&1 \
    || { tail -n 5 "$OUT/.apt.$RUN_ID" >> "$LOG"; rm -f "$OUT/.apt.$RUN_ID"; fail "apt signature check failed in $UPSTREAM (broken keyring or repo access); refusing to build the base. Never use [trusted=yes]/allow-insecure"; }
  rm -f "$OUT/.apt.$RUN_ID"; log "preflight: apt signature check OK"
fi

# ---- base (once per Dockerfile.base hash) ----
export DOCKER_BUILDKIT=1
if [ -n "$NEED_BASE" ] && [ -z "${TRACER_TEST_BREAK_APT:-}" ]; then
  log "== building shared base $BASE_TAG (one-time, slow)"; t0=$(date +%s)
  run_step base-build "${TRACER_TIMEOUT_BASE:-1800}" "" docker build --progress=plain -f "$EXPORT/infra/tracer/Dockerfile.base" -t "$BASE_TAG" "$EXPORT/infra/tracer" >> "$LOG" 2>&1 || fail "base image build failed (see log)"
  BASE_S=$(( $(date +%s) - t0 ))
fi
# ---- per-run image: repo only ----
log "== building per-run image from $COMMIT on $BASE_TAG"; t0=$(date +%s)
run_step build "${TRACER_TIMEOUT_BUILD:-600}" "" docker build --progress=plain --build-arg "BASE=$BASE_TAG" -f "$EXPORT/infra/tracer/Dockerfile" -t "$RUN_IMAGE" "$EXPORT" >> "$LOG" 2>&1 || fail "per-run image build failed (see log)"
BUILD_S=$(( $(date +%s) - t0 )); log "build: ${BUILD_S}s"
if [ -n "$BUILD_ONLY" ]; then docker tag "$RUN_IMAGE" "${TRACER_IMAGE:-wolfpack-tracer}" && RESULT=PASS; exit 0; fi

# ---- run ----
args=(--rm --name "$CNAME" --tmpfs /data:exec,mode=755)
case "$MODE" in
  kb) args+=(-e TRACER_KB=1); LIMIT=300;;
  ro-work) args+=(-e TRACER_KB=1 -e TRACER_RO_WORK=1 --cap-add SYS_ADMIN); LIMIT=300;;
  console) args+=(-e TRACER_CONSOLE=1 -v "$OUT:/out"); LIMIT=420;;
  max)
    f="${CLAUDE_CODE_OAUTH_TOKEN_FILE:-$HOME/.wolfpack/secrets/claude-oauth-token}"; LIMIT=420
    if [ ! -s "$f" ]; then
      [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || fail "--max: no token. Create $f (output of 'claude setup-token', chmod 600) or set CLAUDE_CODE_OAUTH_TOKEN." 2
      TOK_TMP="$(mktemp)"; chmod 600 "$TOK_TMP"; printf '%s' "$CLAUDE_CODE_OAUTH_TOKEN" > "$TOK_TMP"; f="$TOK_TMP"
    fi
    args+=(--mount "type=bind,src=$f,dst=/run/secrets/claude-oauth-token,readonly" -e TRACER_MODE=max);;
  *) LIMIT=240;;
esac
LIMIT="${TRACER_TIMEOUT_RUN:-$LIMIT}"
do_run() { docker run "${args[@]}" ${TRACER_DOCKER_ARGS:-} "$RUN_IMAGE" 2>&1 | tee -a "$LOG"; return "${PIPESTATUS[0]}"; }
run_step "run-$MODE" "$LIMIT" "docker kill $CNAME >/dev/null 2>&1; docker rm -f $CNAME >/dev/null 2>&1" do_run || fail "mode '$MODE' proof failed (exit $?; see log)"
RESULT=PASS
exit 0
