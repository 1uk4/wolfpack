#!/usr/bin/env bash
# C3 proof (needs Docker; native arch, no x64 emulation). Runs deploy-proof-inner.sh in a clean node:22-bookworm container against a local http
# server that mimics the GitHub URL layout. Prints DEPLOY PROOF OK. The systemctl/journalctl are doubles (no systemd in the sandbox): they prove
# OUR logic (verify, unpack, switch, health decision, rollback), not systemd.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
docker run --rm -v "$ROOT/infra/release:/opt/release:ro" --entrypoint bash "${DEPLOY_PROOF_IMAGE:-node:22-bookworm}" /opt/release/deploy-proof-inner.sh
