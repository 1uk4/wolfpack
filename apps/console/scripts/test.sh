#!/usr/bin/env bash
# Console test runner: tsx --test over the given files (default: every tests/**/*.test.{ts,tsx}), 120 s per file.
# Agents: do not run this directly. Use `wolfpack test run apps/console/tests/<file>` (shared queue, one file at a time).
# CI runs the whole suite through `pnpm --filter @wolfpack/console test`.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -x ./node_modules/.bin/tsx ]; then
  TSX=./node_modules/.bin/tsx
elif command -v tsx >/dev/null 2>&1; then
  TSX=$(command -v tsx)
else
  echo "test.sh: tsx not found (looked in apps/console/node_modules/.bin and PATH). Run pnpm install." >&2
  exit 127
fi
if [ "$#" -eq 0 ]; then
  # tests/ mirrors the source tree, so collect recursively.
  set -- $(find tests -type f -name '*.test.ts' -o -name '*.test.tsx' | sort)
  # CONSOLE_TEST_SHARD=N/M (CI) runs only shard N of M of the sorted list; unset runs everything.
  if [ -n "${CONSOLE_TEST_SHARD:-}" ]; then
    set -- $(node scripts/shard-files.mjs "$CONSOLE_TEST_SHARD" "$@")
  fi
fi
# Per-file limit; keep the default equal to CONSOLE_FILE_TIMEOUT_MS in packages/cli/src/test-runner.ts.
NODE_ENV=test exec "$TSX" --test --test-timeout="${CONSOLE_TEST_TIMEOUT_MS:-120000}" "$@"
