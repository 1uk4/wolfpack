#!/usr/bin/env bash
# Console test runner: tsx --test over tests/*.test.{ts,tsx}.
set -euo pipefail
cd "$(dirname "$0")/.."
NODE_ENV=test exec tsx --test tests/*.test.ts tests/*.test.tsx
