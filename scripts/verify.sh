#!/usr/bin/env bash
# Owner entry: scripts/verify.sh <branch|sha> [--console|--kb|--ro-work|--max]
# Runs the tracer from a clean git-archive export of that ref (foreground, bounded, locked) and prints a short summary. Full log path is in the summary.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REF="${1:-}"; [ -n "$REF" ] && [[ "$REF" != --* ]] || { echo "usage: scripts/verify.sh <branch|sha> [--console|--kb|--ro-work|--max]" >&2; exit 2; }
shift
"$ROOT/infra/tracer/run-tracer.sh" --ref "$REF" "$@" > /tmp/verify-$$.out 2>&1; rc=$?
OUT="${TRACER_OUT:-$ROOT/infra/tracer/out}"
echo "verify $REF ${*:-(plain)}: exit $rc"
cat "$OUT/result.txt" 2>/dev/null
if [ $rc -ne 0 ]; then echo "last lines:"; tail -n 5 /tmp/verify-$$.out | cut -c1-200; else grep -E 'PROOF OK|PASS|pong' /tmp/verify-$$.out | tail -n 3 | cut -c1-200; fi
rm -f /tmp/verify-$$.out
exit $rc
