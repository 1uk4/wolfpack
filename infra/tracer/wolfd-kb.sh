#!/usr/bin/env bash
# Tracer --kb wolf launcher: loads the wolf's 600 .env (what systemd EnvironmentFile= does on the VPS: hub URL + wolf-scoped worker token,
# work endpoint) into wolfd's OWN env, then runs the scripted-model stub with the real memory/tasks extensions. workerd never sees these.
set -euo pipefail
set -a; . "${WOLF_HOME:-$HOME}/.env"; set +a
exec node /opt/tracer/stub-wolfd.mjs "$@"
