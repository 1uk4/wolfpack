#!/usr/bin/env bash
# Evidence the wolf authenticated through the Max subscription (OAuth), not an API key. Runs as root in the container, probes as wolf-hal2.
# usage: billing-proof.sh <wolfd-pid> <wolf-home>   exit 0 = proven
set -euo pipefail
PID="$1"; WHOME="$2"
fail() { echo "BILLING FAIL: $*" >&2; exit 1; }
# 1. The running wolfd (and so the claude child the bridge spawns from it): no ANTHROPIC_* credential, OAuth token present. Names only, never values.
names=$(runuser -u wolf-hal2 -- bash -c "tr '\\0' '\\n' < /proc/$PID/environ" | sed 's/=.*//' | sort)  # read as the owner uid (root lacks ptrace in Docker)
echo "wolfd env has CLAUDE_CODE_OAUTH_TOKEN: $(grep -qx CLAUDE_CODE_OAUTH_TOKEN <<<"$names" && echo yes || echo NO)"
echo "wolfd env has ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN: $(grep -Eqx 'ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN' <<<"$names" && echo YES || echo no)"
grep -qx CLAUDE_CODE_OAUTH_TOKEN <<<"$names" || fail "wolfd has no OAuth token"
grep -Eqx 'ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN' <<<"$names" && fail "wolfd env carries an Anthropic API credential"
# 1b. The token must not leak into process args or the logs (checked by value; the value is never printed).
TOK=$(sed -n "s/^CLAUDE_CODE_OAUTH_TOKEN='\(.*\)'$/\1/p" "$WHOME/.env")
psf=$(mktemp); ps -eo args >"$psf"   # snapshot first: a piped grep would match its own argv
grep -qF -- "$TOK" "$psf" && fail "token value found in ps args"
for d in /data/log "$WHOME/wolves" "$WHOME/claude-stateless" "$WHOME/.claude"; do
  if [ -e "$d" ] && grep -rqF -- "$TOK" "$d" 2>/dev/null; then fail "token value found under $d"; fi
done
rm -f "$psf"
unset TOK; echo "token value absent from ps args, /data/log, wolf den and claude state: yes"
# 2. The claude CLI on PATH, run as wolf-hal2 with the wolf's .env: the system init message names the credential source.
out=$(mktemp); trap 'rm -f "$out"' EXIT
runuser -u wolf-hal2 -- bash -c 'set -a; . "$HOME/.env"; set +a; unset ANTHROPIC_API_KEY; cd "$HOME"; exec claude -p "Reply with exactly one word: ok" --model haiku --output-format stream-json --verbose' >"$out" 2>/dev/null || true
init=$(grep -m1 '"subtype":"init"' "$out" || true)
[ -n "$init" ] || fail "no system init message from the claude CLI probe"
src=$(sed -n 's/.*"apiKeySource":"\([^"]*\)".*/\1/p' <<<"$init")
echo "claude CLI system init: apiKeySource=${src:-<absent>}  (claude $(claude --version | cut -d' ' -f1))"
res=$(grep -m1 '"type":"result"' "$out" || true)
echo "probe result: is_error=$(grep -o '"is_error":[a-z]*' <<<"$res" | head -1)  total_cost_usd is a client-side estimate only under OAuth"
grep -q '"is_error":false' <<<"$res" || fail "probe turn errored"
[ "$src" = "ANTHROPIC_API_KEY" ] && fail "apiKeySource says an API key"
[ "$src" = "none" ] || [ "$src" = "oauth" ] || [ "$src" = "temporary" ] || fail "unexpected apiKeySource '$src'"
echo "BILLING PROOF OK: authenticated via CLAUDE_CODE_OAUTH_TOKEN (apiKeySource=$src), no API key in env"
