#!/usr/bin/env bash
# Static check (no systemd needed): the hardening keys that must be present in the wolves units, and the link-only unit untouched vs git HEAD~. Where systemd exists, also runs systemd-analyze verify.
set -euo pipefail
cd "$(dirname "$0")"; fail=0
need() { local f=$1; shift; for k in "$@"; do grep -q "^$k" "$f" || { echo "MISSING in $f: $k"; fail=1; }; done; }
need 'wolfd@.service' User=wolf-%i MemoryMax= NoNewPrivileges=yes ProtectSystem=strict ProtectHome=tmpfs PrivateTmp=yes Restart=on-failure StartLimitBurst= CapabilityBoundingSet=
grep -q 'WOLFPACK_SUBAGENT_HOST_MAX=3' 'wolfd@.service' || { echo "MISSING SUBAGENT_HOST_MAX"; fail=1; }
need workerd-wolves.service User=workerd-wolves NoNewPrivileges=yes ProtectSystem=strict ProtectHome=yes StateDirectory=workerd-wolves CapabilityBoundingSet=
if grep -v '^#' workerd-wolves.service | grep -q -- 'ExecStart=.*--link-only'; then echo "workerd-wolves must not be link-only"; fail=1; fi
git diff --quiet HEAD -- ../../deploy/workerd/workerd.service || { echo "link-only deploy/workerd/workerd.service modified"; fail=1; }
if command -v systemd-analyze >/dev/null; then systemd-analyze verify ./workerd-wolves.service './wolfd@.service' || fail=1; fi
[ $fail = 0 ] && echo "units OK"; exit $fail
