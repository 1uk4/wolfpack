#!/usr/bin/env bash
# wolfd launcher (ships in the release tarball). Loads the wolf's .env (what systemd EnvironmentFile= does too), enforces the
# billing guards, then execs the bundled wolfd with the bundled node_modules. Uses no npm and nothing outside the release.
#   env: WOLF_HOME (default $HOME)  WOLF_ENV_FILE (default $WOLF_HOME/.env)  WOLF_CONFIG (default $WOLF_HOME/wolf.yaml)
#   extra args are passed to wolfd (e.g. --socket PATH | --port N)
set -euo pipefail
REL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WOLF_HOME="${WOLF_HOME:-$HOME}"
ENV_FILE="${WOLF_ENV_FILE:-$WOLF_HOME/.env}"
CONFIG="${WOLF_CONFIG:-$WOLF_HOME/wolf.yaml}"
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "launch.sh: FATAL ANTHROPIC_API_KEY is set; a wolfd wolf never runs on a metered key (the claude CLI would prefer it). Unset it." >&2; exit 78
fi
[ -f "$CONFIG" ] || { echo "launch.sh: $CONFIG missing" >&2; exit 1; }
transport="${WOLF_TRANSPORT:-}"
if [ -z "$transport" ] && [ -f "$(dirname "$CONFIG")/models.json" ]; then
  transport="$(sed -n 's/.*"transport"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' "$(dirname "$CONFIG")/models.json" | head -1)"
fi
if [ "$transport" = subscription ] && [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "launch.sh: FATAL transport is subscription but CLAUDE_CODE_OAUTH_TOKEN is not set in $ENV_FILE" >&2; exit 78
fi
# Extension bundles: this release carries the bundles it was built with (extensions/<dir>/index.js + extensions/STAMP). wolfd loads
# $WOLF_HOME/den/extensions/<dir>/index.js, which nothing else refreshes, so install them here, before wolfd starts. Because launch.sh
# ships per release, a rollback to release.prev runs the old launch.sh and puts the old bundles back. Which dirs: the ones the den
# already has plus the keys in an inline wolf.yaml `extensions: [a, b]` (key -> wolfpack-<key>), only if the release carries them.
# The old dir is MOVED to den/extensions.bak-<UTC ts>, never deleted. Any failure is logged and wolfd starts on the old extensions.
refresh_extensions() {
  local n src="$REL/extensions" den="$WOLF_HOME/den" ext stamp ts new d k keys="" want=""
  [ -f "$src/STAMP" ] || return 0
  ext="$den/extensions"; stamp="$(cat "$src/STAMP")"
  [ "$(cat "$ext/.release-stamp" 2>/dev/null || true)" != "$stamp" ] || return 0
  ts="$(date -u +%Y%m%d%H%M%S)"; n=0
  while [ -e "$den/extensions.bak-$ts" ]; do n=$((n + 1)); ts="$(date -u +%Y%m%d%H%M%S)-$n"; done  # never mv into an existing backup
  new="$den/.extensions.new-$ts"
  [ ! -d "$ext" ] || for d in "$ext"/*/; do want="$want $(basename "$d")"; done
  keys="$(sed -n 's/^extensions:[[:space:]]*\[\(.*\)\].*/\1/p' "$CONFIG" 2>/dev/null | head -1 | tr -d "\"' " | tr ',' ' ')"
  for k in $keys; do want="$want wolfpack-$k"; done
  rm -rf "$new" && mkdir -p "$new" || return 1
  if [ -d "$ext" ]; then cp -R "$ext"/. "$new"/ || { rm -rf "$new"; return 1; }; fi
  for d in $(printf '%s\n' $want | sort -u); do
    [ -f "$src/$d/index.js" ] || continue
    rm -rf "${new:?}/$d" && cp -R "$src/$d" "$new/$d" || { rm -rf "$new"; return 1; }
  done
  chmod -R u+rwX,go+rX-w "$new" 2>/dev/null || true
  printf '%s' "$stamp" > "$new/.release-stamp" || { rm -rf "$new"; return 1; }
  if [ -d "$ext" ]; then mv "$ext" "$den/extensions.bak-$ts" || { rm -rf "$new"; return 1; }; fi
  mv "$new" "$ext" || { [ ! -d "$den/extensions.bak-$ts" ] || mv "$den/extensions.bak-$ts" "$ext"; return 1; }
}
refresh_extensions || echo "launch.sh: extensions NOT refreshed (could not install this release's bundles into $WOLF_HOME/den/extensions; starting wolfd on the existing ones)" >&2

export PATH="$REL/tools/node_modules/.bin:$REL/tools/bin:$PATH"
exec node "$REL/packages/harness/dist/bin/wolfd.js" --config "$CONFIG" "$@"
